import { beforeAll, describe, expect, it } from 'vitest';

import type { ReservationResponse } from '../api/types.js';
import {
  contarEstados,
  crearSala,
  crearUsuario,
  esperarCupo,
  franja,
  llamar,
  loginAdmin,
  saldoDe,
} from './backend.js';

/**
 * Concurrencia real contra proyectoXP: las peticiones salen a la vez con
 * Promise.all y es el backend (transacción + restricciones de PostgreSQL) el
 * que tiene que arbitrar. Cada test usa una sala nueva, así ninguna otra
 * reserva interfiere.
 */
beforeAll(async () => {
  // 3 logins de admin + 6 usuarios × (registro + login) = 15 peticiones de auth
  await esperarCupo({ general: 80, auth: 15 });
});

describe('POST /api/reservations #concurrencia', () => {
  describe('cuando 4 usuarios reservan la misma sala y franja en el mismo instante', () => {
    it('admite exactamente una, rechaza las demás con 409 y solo cobra a quien ganó', async () => {
      // Arrange
      const sala = await crearSala(await loginAdmin(), 20);
      const usuarios = await Promise.all([1, 2, 3, 4].map(() => crearUsuario(100)));
      const tramo = franja(5, 10, 2);

      // Act
      const respuestas = await Promise.all(
        usuarios.map((u) =>
          llamar<ReservationResponse>('POST', '/api/reservations', {
            token: u.token,
            body: { userId: u.id, roomId: sala.id, ...tramo },
          }),
        ),
      );

      // Assert
      expect(contarEstados(respuestas)).toEqual({ 201: 1, 409: 3 });
      const saldos = await Promise.all(usuarios.map(saldoDe));
      expect(saldos.sort((a, b) => a - b)).toEqual([60, 100, 100, 100]);
    });
  });

  describe('cuando el mismo usuario repite en paralelo la misma X-Idempotency-Key', () => {
    it('todas las respuestas son la misma reserva y el saldo se descuenta una sola vez', async () => {
      // Arrange
      const sala = await crearSala(await loginAdmin(), 15);
      const usuario = await crearUsuario(200);
      const peticion = { userId: usuario.id, roomId: sala.id, ...franja(6, 9, 2) };
      const clave = `reserva-${usuario.id}-${Date.now()}`;

      // Act
      const respuestas = await Promise.all(
        Array.from({ length: 5 }, () =>
          llamar<ReservationResponse>('POST', '/api/reservations', {
            token: usuario.token,
            idempotencyKey: clave,
            body: peticion,
          }),
        ),
      );

      // Assert
      expect(contarEstados(respuestas)).toEqual({ 201: 5 });
      expect(new Set(respuestas.map((r) => r.body.id)).size).toBe(1);
      expect(await saldoDe(usuario)).toBe(170);
    });
  });

  describe('cuando un usuario con saldo para una sola reserva dispara 5 distintas en paralelo', () => {
    it('admite una sola, rechaza el resto por saldo insuficiente y el saldo nunca queda negativo', async () => {
      // Arrange: cada reserva cuesta 40 (2 h × 20) y el saldo es 50
      const sala = await crearSala(await loginAdmin(), 20);
      const usuario = await crearUsuario(50);

      // Act: franjas distintas, para que el único árbitro sea el saldo
      const respuestas = await Promise.all(
        [8, 10, 12, 14, 16].map((hora) =>
          llamar<{ error?: string }>('POST', '/api/reservations', {
            token: usuario.token,
            body: { userId: usuario.id, roomId: sala.id, ...franja(7, hora, 2) },
          }),
        ),
      );

      // Assert
      expect(contarEstados(respuestas)).toEqual({ 201: 1, 400: 4 });
      expect(respuestas.filter((r) => r.status === 400).map((r) => r.body.error)).toEqual(
        Array(4).fill('Insufficient balance'),
      );
      expect(await saldoDe(usuario)).toBe(10);
    });
  });
});
