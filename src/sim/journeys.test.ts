import { describe, expect, it } from 'vitest';

import { RECORRIDOS_AUTENTICACION, seleccionarJourney } from './journeys.js';
import { Rng } from './rng.js';

describe('seleccionarJourney', () => {
  describe('con la mezcla de autenticación', () => {
    it('solo elige recorridos de login y alta, que son los que cargan la CPU con bcrypt', () => {
      const rng = new Rng(7);
      const permitidos = new Set(RECORRIDOS_AUTENTICACION.map((j) => j.name));

      const elegidos = Array.from({ length: 300 }, () =>
        seleccionarJourney(rng, { chaos: true, adminDisponible: true, mezcla: 'autenticacion' }).name,
      );

      expect(elegidos.every((n) => permitidos.has(n))).toBe(true);
      expect(new Set(elegidos)).toContain('reingreso');
    });
  });

  describe('con la mezcla realista', () => {
    it('nunca elige el recorrido de reingreso', () => {
      const rng = new Rng(7);

      const elegidos = Array.from({ length: 300 }, () =>
        seleccionarJourney(rng, { chaos: true, adminDisponible: true }).name,
      );

      expect(elegidos).not.toContain('reingreso');
    });
  });
});
