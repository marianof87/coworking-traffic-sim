/**
 * IP de origen por usuario virtual (`--ips-virtuales`).
 *
 * Sin esto, todo el tráfico del simulador sale de una sola IP y el rate limit
 * por IP del backend lo frena en conjunto (300/min = 5 peticiones/s para
 * TODOS los usuarios). Con IPs virtuales cada persona tiene la suya, como en
 * la realidad: el límite frena a quien se excede y el resto genera carga.
 *
 * Viaja en `X-Forwarded-For`; el backend solo la usa si confía en el proxy
 * (`TRUST_PROXY=true` en proyectoXP, pensado para la demo).
 *
 * AsyncLocalStorage la propaga por toda la cadena async de una sesión, así
 * ningún recorrido tiene que pasarla a mano.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const origen = new AsyncLocalStorage<string>();

/** IP privada estable (10.x.y.z) derivada del email: la misma persona, la misma IP. */
export const ipVirtual = (email: string): string => {
  let h = 2166136261;
  for (let i = 0; i < email.length; i += 1) {
    h ^= email.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `10.${(h >>> 16) & 0xff}.${(h >>> 8) & 0xff}.${(h & 0xff) || 1}`;
};
