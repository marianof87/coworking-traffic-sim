import { beforeAll, describe, expect, it } from 'vitest';

import { ApiClient } from '../api/client.js';
import { MetricsCollector } from '../metrics/collector.js';
import {
  BASE_URL,
  contarEstados,
  crearUsuario,
  dormir,
  esperarCupo,
  leerCupo,
  llamar,
  sondearAuth,
  sondearGeneral,
  type Cupo,
} from './backend.js';

/**
 * Rate limit de proyectoXP (HU-12): ventana fija por IP, un límite general
 * para /api y otro más estricto para login/registro. Las cuentas son exactas
 * porque antes de cada ráfaga se lee el cupo restante en X-RateLimit-Remaining:
 * de una ráfaga de `restantes + extra` peticiones, entran `restantes` y se
 * rechazan `extra`.
 */

/** Si la ventana está por vencer, espera a la siguiente para que no se reinicie a mitad de la ráfaga. */
const cupoEstable = async (sondear: () => Promise<Cupo>): Promise<Cupo> => {
  const cupo = await sondear();
  if (cupo.reiniciaEnMs > 15_000) return cupo;
  await dormir(cupo.reiniciaEnMs + 500);
  return sondear();
};

interface CuerpoRechazo {
  error: string;
  retryAfter: number;
}

beforeAll(async () => {
  await esperarCupo({ general: 40, auth: 3 });
});

describe('Rate limit de login/registro #rate-limit', () => {
  describe('cuando una ráfaga de logins supera el cupo de auth de la IP', () => {
    it('evalúa exactamente las que entran en el cupo y rechaza el excedente con 429 y Retry-After', async () => {
      // Arrange
      const extra = 5;
      const { restantes, limite } = await cupoEstable(sondearAuth);
      const credencialesErroneas = { email: 'tomas.herrera@example.com', password: 'clave-equivocada' };

      // Act
      const respuestas = await Promise.all(
        Array.from({ length: restantes + extra }, () =>
          llamar<CuerpoRechazo>('POST', '/api/users/login', { body: credencialesErroneas }),
        ),
      );

      // Assert: 401 = el backend la procesó (contraseña mala); 429 = ni la miró
      expect(contarEstados(respuestas)).toEqual(restantes > 0 ? { 401: restantes, 429: extra } : { 429: extra });
      const rechazadas = respuestas.filter((r) => r.status === 429);
      for (const r of rechazadas) {
        const retryAfter = Number(r.headers.get('retry-after'));
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(60);
        expect(r.body).toEqual({ error: 'Too many requests', retryAfter });
        expect(leerCupo(r.headers)).toMatchObject({ limite, restantes: 0 });
      }
    });
  });

  describe('cuando el cupo de auth de la IP está agotado', () => {
    it('también rechaza el login de un usuario legítimo con la contraseña correcta', async () => {
      // Arrange: usuario real creado con cupo; después alguien agota el cupo desde la misma IP
      await esperarCupo({ general: 40, auth: 3 });
      const victima = await crearUsuario();
      const { restantes } = await cupoEstable(sondearAuth);
      await Promise.all(
        Array.from({ length: restantes + 1 }, () =>
          llamar('POST', '/api/users/login', { body: { email: 'atacante@example.com', password: 'x' } }),
        ),
      );

      // Act
      const login = await llamar('POST', '/api/users/login', {
        body: { email: victima.email, password: 'SimPass123!' },
      });

      // Assert: el límite es por IP, no por cuenta
      expect(login.status).toBe(429);
    });
  });
});

describe('Rate limit general de /api #rate-limit', () => {
  describe('cuando el simulador lanza una ráfaga que supera el cupo de la IP', () => {
    it('sus métricas cuentan como rechazadas exactamente las peticiones que el backend no admitió', async () => {
      // Arrange: el cliente y el colector reales del simulador
      const extra = 20;
      const metrics = new MetricsCollector();
      const api = new ApiClient(BASE_URL, (o) => metrics.registrar(o), 10_000);
      const { restantes } = await cupoEstable(sondearGeneral);

      // Act
      await Promise.allSettled(Array.from({ length: restantes + extra }, () => api.get('/api/rooms')));
      const { porEstado, endpoints } = metrics.snapshot();

      // Assert
      expect(porEstado).toMatchObject({ ok2xx: restantes, rateLimited429: extra, server5xx: 0, red: 0 });
      expect(endpoints).toEqual([
        expect.objectContaining({ endpoint: 'GET /api/rooms', count: restantes + extra, rateLimited429: extra }),
      ]);
    });
  });

  describe('cuando el cupo general está agotado', () => {
    it('/health sigue respondiendo porque el límite solo cubre /api', async () => {
      // Arrange
      const { restantes } = await cupoEstable(sondearGeneral);
      await Promise.all(Array.from({ length: restantes + 1 }, () => llamar('GET', '/api/rooms')));

      // Act
      const [api, salud] = await Promise.all([llamar('GET', '/api/rooms'), llamar('GET', '/health')]);

      // Assert
      expect(api.status).toBe(429);
      expect(salud.status).toBe(200);
    });

    it('vuelve a admitir peticiones cuando pasa el tiempo indicado en Retry-After', async () => {
      // Arrange
      const { restantes } = await cupoEstable(sondearGeneral);
      await Promise.all(Array.from({ length: restantes }, () => llamar('GET', '/api/rooms')));
      const rechazada = await llamar('GET', '/api/rooms');
      expect(rechazada.status).toBe(429);

      // Act
      await dormir(Number(rechazada.headers.get('retry-after')) * 1000 + 500);
      const reintento = await llamar('GET', '/api/rooms');

      // Assert
      expect(reintento.status).toBe(200);
    });
  });
});
