import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Rng } from './rng.js';

describe('Rng', () => {
  describe('con la misma semilla', () => {
    it('repite exactamente la misma secuencia (corridas reproducibles)', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 2 ** 32 - 1 }), (seed) => {
          const a = new Rng(seed);
          const b = new Rng(seed);

          const secuenciaA = Array.from({ length: 20 }, () => a.next());
          const secuenciaB = Array.from({ length: 20 }, () => b.next());

          expect(secuenciaA).toEqual(secuenciaB);
        }),
      );
    });
  });

  describe('int', () => {
    it('siempre devuelve un entero dentro del rango, con ambos extremos incluidos', () => {
      fc.assert(
        fc.property(fc.integer(), fc.integer({ min: -1000, max: 1000 }), fc.nat(1000), (seed, min, ancho) => {
          const valor = new Rng(seed).int(min, min + ancho);

          expect(Number.isInteger(valor)).toBe(true);
          expect(valor).toBeGreaterThanOrEqual(min);
          expect(valor).toBeLessThanOrEqual(min + ancho);
        }),
      );
    });
  });

  describe('exponential', () => {
    it('nunca devuelve un think time negativo', () => {
      fc.assert(
        fc.property(fc.integer(), fc.float({ min: 0, max: 10_000, noNaN: true }), (seed, media) => {
          expect(new Rng(seed).exponential(media)).toBeGreaterThanOrEqual(0);
        }),
      );
    });
  });

  describe('pick', () => {
    it('con una colección vacía lanza un error claro', () => {
      expect(() => new Rng(1).pick([])).toThrow('Rng.pick: colección vacía');
    });
  });
});
