import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildConfig, parseDuration, parseEscalones, tasaEnEscalon } from './config.js';

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
        ipsVirtuales: false,
        escalones: null,
        mezcla: 'realista',
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

describe('parseEscalones', () => {
  describe('con una lista de tasas', () => {
    it('la convierte en números en el mismo orden', () => {
      expect(parseEscalones('2, 5,10,20')).toEqual([2, 5, 10, 20]);
    });
  });

  describe('vacía o ausente', () => {
    it('devuelve null (tasa fija)', () => {
      expect(parseEscalones(undefined)).toBeNull();
      expect(parseEscalones('  ')).toBeNull();
    });
  });

  describe('con una tasa que no es positiva', () => {
    it('rechaza la lista mostrando el valor recibido', () => {
      expect(() => parseEscalones('2,0,10')).toThrow('--escalones: "2,0,10"');
    });
  });
});

describe('tasaEnEscalon', () => {
  describe('con 4 escalones en 60 s', () => {
    it.each([
      [0, 2],
      [14_999, 2],
      [15_000, 5],
      [44_000, 10],
      [59_999, 20],
      [90_000, 20],
    ])('a los %i ms la tasa es %i', (transcurrido, esperada) => {
      expect(tasaEnEscalon([2, 5, 10, 20], transcurrido, 60_000)).toBe(esperada);
    });
  });

  it('siempre devuelve una de las tasas de la lista, cualquiera sea el momento', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 10 }),
        fc.integer({ min: -1000, max: 10_000_000 }),
        fc.integer({ min: 1, max: 3_600_000 }),
        (escalones, transcurrido, duracion) => {
          expect(escalones).toContain(tasaEnEscalon(escalones, transcurrido, duracion));
        },
      ),
    );
  });
});
