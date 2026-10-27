import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RequestOutcome } from '../api/client.js';
import { MetricsCollector, percentil } from './collector.js';

const respuesta = (status: number, endpoint = 'GET /api/rooms', durationMs = 12): RequestOutcome => ({
  method: endpoint.split(' ')[0] ?? 'GET',
  endpoint,
  status,
  durationMs,
});

describe('MetricsCollector', () => {
  describe('cuando el backend rechaza peticiones por rate limit (429)', () => {
    it('las cuenta como rechazadas aparte, sin dejar de contarlas como 4xx', () => {
      // Arrange
      const metrics = new MetricsCollector();
      const estados = [200, 200, 201, 429, 429, 429, 409, 401];

      // Act
      estados.forEach((s) => metrics.registrar(respuesta(s)));
      const { porEstado } = metrics.snapshot();

      // Assert
      expect(porEstado).toEqual({ ok2xx: 3, client4xx: 5, server5xx: 0, red: 0, rateLimited429: 3 });
    });

    it('informa por endpoint cuántas peticiones fueron rechazadas', () => {
      // Arrange
      const metrics = new MetricsCollector();
      metrics.registrar(respuesta(200, 'POST /api/users/login'));
      metrics.registrar(respuesta(429, 'POST /api/users/login'));
      metrics.registrar(respuesta(429, 'POST /api/users/login'));
      metrics.registrar(respuesta(200, 'GET /api/rooms'));

      // Act
      const { endpoints } = metrics.snapshot();

      // Assert
      expect(endpoints.map((e) => [e.endpoint, e.count, e.rateLimited429])).toEqual([
        ['POST /api/users/login', 3, 2],
        ['GET /api/rooms', 1, 0],
      ]);
    });
  });

  describe('cuando se registran respuestas de cualquier tipo', () => {
    it('admitidas + rechazadas por rate limit + otros errores suman el total de peticiones', () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(0, 200, 201, 204, 400, 401, 403, 404, 409, 429, 500, 503)),
          (estados) => {
            // Arrange
            const metrics = new MetricsCollector();

            // Act
            estados.forEach((s) => metrics.registrar(respuesta(s)));
            const { totalRequests, porEstado: e } = metrics.snapshot();

            // Assert
            expect(e.ok2xx + e.client4xx + e.server5xx + e.red).toBe(totalRequests);
            expect(e.rateLimited429).toBe(estados.filter((s) => s === 429).length);
            expect(e.rateLimited429).toBeLessThanOrEqual(e.client4xx);
          },
        ),
      );
    });
  });

  describe('reset', () => {
    it('al terminar el calentamiento descarta lo registrado hasta entonces', () => {
      // Arrange
      const metrics = new MetricsCollector();
      metrics.registrar(respuesta(429));

      // Act
      metrics.reset();

      // Assert
      expect(metrics.snapshot().totalRequests).toBe(0);
    });
  });
});

describe('percentil', () => {
  describe('cuando la lista está vacía', () => {
    it('devuelve 0', () => {
      expect(percentil([], 95)).toBe(0);
    });
  });

  describe('con cualquier lista ordenada de latencias', () => {
    it('devuelve un valor de la lista y nunca decrece al subir el percentil', () => {
      fc.assert(
        fc.property(
          fc.array(fc.float({ min: 0, max: 10_000, noNaN: true }), { minLength: 1 }),
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 100 }),
          (latencias, p1, p2) => {
            const ordenadas = [...latencias].sort((a, b) => a - b);
            const [bajo, alto] = p1 <= p2 ? [p1, p2] : [p2, p1];

            expect(ordenadas).toContain(percentil(ordenadas, bajo));
            expect(percentil(ordenadas, bajo)).toBeLessThanOrEqual(percentil(ordenadas, alto));
          },
        ),
      );
    });

    it('el p100 es el máximo', () => {
      expect(percentil([3, 7, 7, 120], 100)).toBe(120);
    });
  });
});
