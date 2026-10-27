/**
 * Escenarios de carga predefinidos: los mismos que lanzan los botones del
 * monitor de proyectoXP y `proyectoXP/escenarios.sh`.
 */

import type { CliOptions } from './config.js';

export interface Escenario {
  nombre: string;
  titulo: string;
  descripcion: string;
  /** `tasa` (sesiones/s) solo la usan los escenarios que la aceptan. */
  opciones: (tasa?: number) => CliOptions;
  aceptaTasa?: boolean;
}

export const ESCENARIOS: Escenario[] = [
  {
    nombre: 'baja',
    titulo: 'Carga baja',
    descripcion: '2 sesiones/s durante 1 minuto: todo admitido, la CPU casi en reposo.',
    opciones: () => ({ duration: '1m', rps: '2', users: '20' }),
  },
  {
    nombre: 'creciente',
    titulo: 'Carga creciente',
    descripcion: 'Escalones de 2 → 5 → 10 → 20 → 40 → 80 sesiones/s en 3 minutos: la presión sube a la vista.',
    opciones: () => ({ duration: '3m', escalones: '2,5,10,20,40,80', users: '200', maxConcurrent: '300' }),
  },
  {
    nombre: 'saturacion',
    titulo: 'Saturación de CPU',
    descripcion:
      'Logins en masa durante 2 minutos: cada uno es un hash bcrypt en un worker thread. Probar los botones de Hilos.',
    opciones: (tasa = 60) => ({
      duration: '2m',
      rps: String(tasa),
      users: '300',
      maxConcurrent: '400',
      mezcla: 'autenticacion',
    }),
    aceptaTasa: true,
  },
  {
    nombre: 'rate-limit',
    titulo: 'Rate limit',
    descripcion: 'Todo el tráfico desde UNA sola IP durante 1 minuto: choca con el límite y llueven los 429.',
    opciones: () => ({ duration: '1m', rps: '20', users: '25', ipsVirtuales: false }),
  },
];

export const buscarEscenario = (nombre: string): Escenario | undefined =>
  ESCENARIOS.find((e) => e.nombre === nombre);
