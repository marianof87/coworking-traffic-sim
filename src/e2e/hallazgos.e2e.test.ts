import { beforeAll, describe, expect, it } from 'vitest';

import type { ReservationResponse } from '../api/types.js';
import { crearSala, crearUsuario, esperarCupo, franja, llamar, loginAdmin, saldoDe } from './backend.js';

/**
 * Defectos de proyectoXP encontrados al consumir su API desde el simulador.
 *
 * Cada prueba describe el comportamiento CORRECTO. Están marcadas con
 * `it.fails` mientras el defecto siga en el backend (la suite queda verde y
 * el defecto documentado); cuando se corrija, la prueba empezará a "fallar
 * por pasar": entonces se quita el `.fails`.
 */
beforeAll(async () => {
  // 2 logins de admin + 4 usuarios × (registro + login) = 10 peticiones de auth
  await esperarCupo({ general: 40, auth: 10 });
});

describe('POST /api/reservations #hallazgo', () => {
  describe('cuando un usuario autenticado manda el userId de OTRA persona en el body', () => {
    // Defecto: ReservationController toma `userId` del body y no lo compara con
    // el usuario del token, así que cualquiera puede reservar cobrándole a otro.
    it.fails('responde 403 y no le descuenta saldo a la otra persona', async () => {
      // Arrange
      const sala = await crearSala(await loginAdmin(), 10);
      const atacante = await crearUsuario();
      const victima = await crearUsuario(300);

      // Act
      const respuesta = await llamar('POST', '/api/reservations', {
        token: atacante.token,
        body: { userId: victima.id, roomId: sala.id, ...franja(9, 11, 3) },
      });

      // Assert
      expect(respuesta.status).toBe(403);
      expect(await saldoDe(victima)).toBe(300);
    });
  });

  describe('cuando otro usuario reutiliza una X-Idempotency-Key que ya usó alguien más', () => {
    // Defecto: las claves de idempotencia son globales, no por usuario; el
    // segundo usuario recibe 201 con la reserva (y los datos) del primero.
    it.fails('no le devuelve la reserva ajena', async () => {
      // Arrange
      const sala = await crearSala(await loginAdmin(), 12);
      const primera = await crearUsuario(200);
      const segunda = await crearUsuario(200);
      const clave = `pedido-${Date.now()}`;
      const original = await llamar<ReservationResponse>('POST', '/api/reservations', {
        token: primera.token,
        idempotencyKey: clave,
        body: { userId: primera.id, roomId: sala.id, ...franja(10, 9) },
      });

      // Act
      const respuesta = await llamar<ReservationResponse>('POST', '/api/reservations', {
        token: segunda.token,
        idempotencyKey: clave,
        body: { userId: segunda.id, roomId: sala.id, ...franja(10, 15) },
      });

      // Assert
      expect(original.status).toBe(201);
      expect(respuesta.body.userId).toBe(segunda.id);
    });
  });
});
