import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';

import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiClient, normalizarEndpoint, type RequestOutcome } from './client.js';
import { ApiError, NetworkError, esperarEstado } from './errors.js';
import { origen } from './origen.js';

/**
 * Test de componente: el cliente real contra un servidor HTTP real en un
 * puerto efímero. Cada test levanta su propio servidor con la respuesta que
 * necesita (sin fixtures globales); `afterEach` solo lo cierra.
 */
const abiertos: Array<() => Promise<void>> = [];

const levantarServidor = async (handler: RequestListener): Promise<string> => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  abiertos.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const clienteObservado = (baseUrl: string, timeoutMs = 2_000) => {
  const observadas: RequestOutcome[] = [];
  const api = new ApiClient(baseUrl, (o) => observadas.push(o), timeoutMs);
  return { api, observadas };
};

afterEach(async () => {
  await Promise.all(abiertos.splice(0).map((cerrar) => cerrar()));
});

describe('ApiClient', () => {
  describe('cuando el backend responde 429 por rate limit', () => {
    it('rechaza con ApiError 429 y el mensaje del backend', async () => {
      // Arrange: misma forma que el rateLimiter de proyectoXP
      const baseUrl = await levantarServidor((_req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '37' });
        res.end(JSON.stringify({ error: 'Too many requests', retryAfter: 37 }));
      });
      const { api } = clienteObservado(baseUrl);

      // Act
      const peticion = api.post('/api/users/login', { email: 'lucia.medina@example.com', password: 'x' });

      // Assert
      await expect(peticion).rejects.toBeInstanceOf(ApiError);
      await expect(peticion).rejects.toMatchObject({ status: 429, serverMessage: 'Too many requests' });
    });

    it('igual registra la petición en las métricas, con su status y endpoint normalizado', async () => {
      // Arrange
      const baseUrl = await levantarServidor((_req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many requests', retryAfter: 12 }));
      });
      const { api, observadas } = clienteObservado(baseUrl);

      // Act
      await api.get('/api/users/8812/reservations').catch(() => undefined);

      // Assert
      expect(observadas).toEqual([
        expect.objectContaining({ method: 'GET', endpoint: 'GET /api/users/:id/reservations', status: 429 }),
      ]);
    });
  });

  describe('cuando el backend admite la petición', () => {
    it('devuelve el body JSON y manda token y clave de idempotencia', async () => {
      // Arrange
      let cabeceras: Record<string, string | string[] | undefined> = {};
      const baseUrl = await levantarServidor((req, res) => {
        cabeceras = req.headers;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 314, status: 'CONFIRMED' }));
      });
      const { api } = clienteObservado(baseUrl);

      // Act
      const reserva = await api.post('/api/reservations', { roomId: 3 }, { token: 'jwt-abc', idempotencyKey: 'k-77' });

      // Assert
      expect(reserva).toEqual({ id: 314, status: 'CONFIRMED' });
      expect(cabeceras).toMatchObject({ authorization: 'Bearer jwt-abc', 'x-idempotency-key': 'k-77' });
    });
  });

  describe('cuando la sesión corre con una IP virtual (--ips-virtuales)', () => {
    it('manda esa IP en X-Forwarded-For; fuera de la sesión no manda nada', async () => {
      // Arrange
      const recibidas: Array<string | undefined> = [];
      const baseUrl = await levantarServidor((req, res) => {
        recibidas.push(req.headers['x-forwarded-for'] as string | undefined);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      });
      const { api } = clienteObservado(baseUrl);

      // Act
      await origen.run('10.20.30.40', () => api.get('/api/rooms'));
      await api.get('/api/rooms');

      // Assert
      expect(recibidas).toEqual(['10.20.30.40', undefined]);
    });
  });

  describe('cuando el backend no contesta dentro del timeout', () => {
    it('rechaza con NetworkError y lo observa como status 0', async () => {
      // Arrange: un servidor que nunca responde
      const baseUrl = await levantarServidor(() => undefined);
      const { api, observadas } = clienteObservado(baseUrl, 100);

      // Act
      const peticion = api.get('/api/rooms');

      // Assert
      await expect(peticion).rejects.toBeInstanceOf(NetworkError);
      expect(observadas).toEqual([expect.objectContaining({ status: 0 })]);
    });
  });

  describe('cuando otra aplicación ocupa el puerto y responde HTML con 200', () => {
    it('rechaza con NetworkError explicando que la respuesta no es JSON', async () => {
      // Arrange
      const baseUrl = await levantarServidor((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>Vite</title>');
      });
      const { api } = clienteObservado(baseUrl);

      // Act + Assert
      await expect(api.get('/health')).rejects.toThrow(/la respuesta no es JSON \(content-type: text\/html/);
    });
  });
});

describe('normalizarEndpoint', () => {
  it('agrupa por recurso cualquiera sea el id numérico', () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), (userId, reservaId) => {
        expect(normalizarEndpoint('GET', `/api/users/${userId}/reservations`)).toBe('GET /api/users/:id/reservations');
        expect(normalizarEndpoint('DELETE', `/api/reservations/${reservaId}`)).toBe('DELETE /api/reservations/:id');
      }),
    );
  });
});

describe('esperarEstado', () => {
  describe('cuando el error es el status esperado por el recorrido', () => {
    it('lo traga', () => {
      expect(() => esperarEstado(new ApiError(409, 'POST', '/api/reservations', 'ocupada'), 409)).not.toThrow();
    });
  });

  describe('cuando el backend respondió 429 en un recorrido que esperaba otro error', () => {
    it('lo propaga: un rate limit no es el error "legítimo" que se quería provocar', () => {
      const rechazo = new ApiError(429, 'GET', '/api/users/999999', 'Too many requests');

      expect(() => esperarEstado(rechazo, 404)).toThrow(rechazo);
    });
  });
});
