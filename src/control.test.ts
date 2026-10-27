import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { Controlador, crearServidorDeControl, resumir } from './control.js';
import { MetricsCollector } from './metrics/collector.js';

/** Backend inexistente: una corrida falla rápido (chequeo de salud) y deja rastro en /estado. */
const SIN_BACKEND = { baseUrl: 'http://127.0.0.1:9', timeout: '200' };

const abiertos: Array<() => void> = [];

const levantar = async () => {
  const controlador = new Controlador(SIN_BACKEND, {});
  const servidor = crearServidorDeControl(controlador);
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  abiertos.push(() => servidor.close());
  const base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  const post = (ruta: string) => fetch(`${base}${ruta}`, { method: 'POST' });
  const estado = async () => (await (await fetch(`${base}/estado`)).json()) as {
    corriendo: boolean;
    actual: { escenario: string } | null;
    ultima: { escenario: string; motivo: string; error?: string } | null;
  };
  return { base, post, estado };
};

afterEach(() => {
  abiertos.splice(0).forEach((cerrar) => cerrar());
});

describe('Servidor de control del simulador', () => {
  describe('GET /escenarios', () => {
    it('lista los cuatro escenarios de los botones del monitor', async () => {
      const { base } = await levantar();

      const lista = (await (await fetch(`${base}/escenarios`)).json()) as Array<{ nombre: string; aceptaTasa: boolean }>;

      expect(lista.map((e) => e.nombre)).toEqual(['baja', 'creciente', 'saturacion', 'rate-limit']);
      expect(lista.find((e) => e.nombre === 'saturacion')?.aceptaTasa).toBe(true);
    });
  });

  describe('POST /escenarios/:nombre', () => {
    it('con un escenario que no existe responde 404', async () => {
      const { post } = await levantar();

      expect((await post('/escenarios/terremoto')).status).toBe(404);
    });

    it('con una tasa fuera de rango responde 400 y no arranca nada', async () => {
      const { post, estado } = await levantar();

      const res = await post('/escenarios/saturacion?tasa=0');

      expect(res.status).toBe(400);
      expect((await estado()).corriendo).toBe(false);
    });

    it('mientras corre un escenario rechaza otro con 409', async () => {
      // Arrange
      const { post } = await levantar();

      // Act
      const primero = await post('/escenarios/baja');
      const segundo = await post('/escenarios/creciente');

      // Assert
      expect(primero.status).toBe(202);
      expect(segundo.status).toBe(409);
    });

    it('si la API no responde, la corrida termina con motivo "error" y el control queda libre', async () => {
      // Arrange
      const { post, estado } = await levantar();

      // Act
      await post('/escenarios/baja');
      let e = await estado();
      while (e.corriendo) {
        await new Promise((r) => setTimeout(r, 200));
        e = await estado();
      }

      // Assert
      expect(e.ultima).toMatchObject({ escenario: 'baja', motivo: 'error' });
      expect(e.ultima?.error).toContain('No se pudo contactar la API');
      expect((await post('/escenarios/baja')).status).toBe(202);
    }, 15_000);
  });

  describe('POST /detener', () => {
    it('sin nada corriendo responde que no había nada que detener', async () => {
      const { post } = await levantar();

      expect(await (await post('/detener')).json()).toEqual({ detenido: false });
    });
  });
});

describe('resumir', () => {
  it('admitidas + rechazadas por rate limit + errores de red suman el total de peticiones', () => {
    // Arrange
    const metrics = new MetricsCollector();
    [200, 201, 429, 429, 0, 409, 500].forEach((status) =>
      metrics.registrar({ method: 'GET', endpoint: 'GET /api/rooms', status, durationMs: 5 }),
    );

    // Act
    const r = resumir(metrics.snapshot());

    // Assert
    expect(r).toMatchObject({ peticiones: 7, admitidas: 4, rechazadas429: 2, erroresDeRed: 1, errores5xx: 1 });
  });
});
