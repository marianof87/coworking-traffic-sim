import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { UserPool } from './pool.js';
import type { VirtualUser } from './user.js';

/** El pool solo mueve referencias: para probarlo alcanza con objetos con identidad. */
const usuarios = (n: number): VirtualUser[] =>
  Array.from({ length: n }, (_, i) => ({ persona: { email: `persona-${i}@example.com` } }) as VirtualUser);

const pausa = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('UserPool', () => {
  describe('cuando hay más sesiones concurrentes que usuarios', () => {
    it('nunca entrega el mismo usuario a dos sesiones a la vez y todas terminan', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 30 }),
          async (cantidadUsuarios, duracionesMs) => {
            // Arrange
            const pool = new UserPool(usuarios(cantidadUsuarios));
            const ocupados = new Set<VirtualUser>();
            let maxSimultaneos = 0;

            // Act
            await Promise.all(
              duracionesMs.map(async (ms) => {
                const user = await pool.acquire();
                expect(ocupados.has(user)).toBe(false);
                ocupados.add(user);
                maxSimultaneos = Math.max(maxSimultaneos, ocupados.size);
                await pausa(ms);
                ocupados.delete(user);
                pool.release(user);
              }),
            );

            // Assert
            expect(maxSimultaneos).toBeLessThanOrEqual(cantidadUsuarios);
            expect(pool.tamanio).toBe(cantidadUsuarios);
          },
        ),
        { numRuns: 40 },
      );
    });
  });

  describe('cuando las sesiones van de a una', () => {
    it('rota los usuarios: el que lleva más tiempo libre sale primero', async () => {
      // Arrange
      const pool = new UserPool(usuarios(3));
      const vistos: string[] = [];

      // Act
      for (let i = 0; i < 6; i += 1) {
        const user = await pool.acquire();
        vistos.push(user.persona.email);
        pool.release(user);
      }

      // Assert: cada usuario aparece dos veces, en ronda
      expect(vistos).toEqual([
        'persona-0@example.com', 'persona-1@example.com', 'persona-2@example.com',
        'persona-0@example.com', 'persona-1@example.com', 'persona-2@example.com',
      ]);
    });
  });

  describe('cuando un usuario se libera y hay sesiones esperando', () => {
    it('se lo entrega a la primera que llegó (FIFO)', async () => {
      // Arrange
      const [unico] = usuarios(1);
      const pool = new UserPool([unico!]);
      const enUso = await pool.acquire();
      const orden: string[] = [];
      const primera = pool.acquire().then(() => orden.push('primera'));
      const segunda = pool.acquire().then(() => orden.push('segunda'));

      // Act
      pool.release(enUso);
      await primera;
      pool.release(enUso);
      await segunda;

      // Assert
      expect(orden).toEqual(['primera', 'segunda']);
    });
  });
});
