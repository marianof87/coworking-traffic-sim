/** Selección de franjas horarias para las reservas de los usuarios virtuales. */

import { Rng } from './rng.js';

export interface Slot {
  start: Date;
  end: Date;
}

const MS_POR_HORA = 3_600_000;

/**
 * Franja realista de reserva: dentro de los próximos `diasMax` días, en
 * horario comercial (8 a 18 h), de 1 a 4 horas. El backend no valida que la
 * fecha sea futura, pero una persona no reserva en el pasado: la simulación sí.
 */
export const elegirSlotFuturo = (rng: Rng, diasMax: number = 14, ahora: Date = new Date()): Slot => {
  const diasAdelante = rng.int(1, Math.max(1, diasMax));
  const horaInicio = rng.int(8, 17);
  const horas = rng.int(1, 4);

  const start = new Date(ahora);
  start.setDate(start.getDate() + diasAdelante);
  start.setHours(horaInicio, 0, 0, 0);

  return { start, end: new Date(start.getTime() + horas * MS_POR_HORA) };
};

/** Coste que el backend calculará: horas × tarifa horaria de la sala. */
export const horasDe = (slot: Slot): number =>
  (slot.end.getTime() - slot.start.getTime()) / MS_POR_HORA;
