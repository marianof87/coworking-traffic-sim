import { describe, expect, it } from 'vitest';

import { buildConfig, parseDuration } from './config.js';

describe('parseDuration', () => {
  describe('con las unidades que acepta la CLI', () => {
    it.each([
      ['90', 90_000],
      ['90s', 90_000],
      ['2m', 120_000],
      ['1h', 3_600_000],
      ['250ms', 250],
      ['1.5s', 1_500],
    ])('"%s" son %i ms', (entrada, esperado) => {
      expect(parseDuration(entrada)).toBe(esperado);
    });
  });

  describe('con un texto que no es una duración', () => {
    it('lanza un error que muestra el valor recibido', () => {
      expect(() => parseDuration('dos minutos')).toThrow('Duración inválida: "dos minutos"');
    });
  });
});

describe('buildConfig', () => {
  describe('sin flags ni variables de entorno', () => {
    it('usa los valores por defecto documentados en el README', () => {
      const cfg = buildConfig({}, {});

      expect(cfg).toMatchObject({
        baseUrl: 'http://localhost:3000',
        durationMs: 60_000,
        mode: 'open',
        rps: 5,
        users: 25,
        maxConcurrent: 40,
        seed: 42,
        chaos: true,
        adminEmail: null,
      });
    });
  });

  describe('cuando la URL base trae barras finales', () => {
    it('las quita para no generar rutas con doble barra', () => {
      expect(buildConfig({ baseUrl: 'http://localhost:3300//' }, {}).baseUrl).toBe('http://localhost:3300');
    });
  });

  describe('cuando el modo no es open ni closed', () => {
    it('rechaza la configuración', () => {
      expect(() => buildConfig({ mode: 'burst' }, {})).toThrow('--mode debe ser "open" o "closed"');
    });
  });
});
