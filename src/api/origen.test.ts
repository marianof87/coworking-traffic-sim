import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ipVirtual } from './origen.js';

describe('ipVirtual', () => {
  describe('para cualquier email', () => {
    it('devuelve una IPv4 privada 10.x.y.z válida y siempre la misma', () => {
      fc.assert(
        fc.property(fc.emailAddress(), (email) => {
          const ip = ipVirtual(email);

          expect(ip).toMatch(/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
          expect(ip.split('.').map(Number).every((n) => n >= 0 && n <= 255)).toBe(true);
          expect(ipVirtual(email)).toBe(ip);
        }),
      );
    });
  });

  describe('con 500 personas de una corrida', () => {
    it('reparte IPs distintas (casi sin colisiones), para que el rate limit las cuente por separado', () => {
      const emails = Array.from({ length: 500 }, (_, n) => `sim-s42-run-${n + 1}@example.com`);

      expect(new Set(emails.map(ipVirtual)).size).toBeGreaterThanOrEqual(495);
    });
  });
});
