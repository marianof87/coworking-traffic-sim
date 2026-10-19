/** Estado compartido entre sesiones: catálogo de salas y libro de reservas. */

import type { ReservationResponse, RoomResponse } from '../api/types.js';

/** Nombres de sala que el admin del simulador crea si faltan (catálogo fijo). */
const CATALOGO_SALAS: Array<{ name: string; capacity: number; hourlyRate: number }> = [
  { name: 'Sala Palermo', capacity: 8, hourlyRate: 25 },
  { name: 'Sala Belgrano', capacity: 4, hourlyRate: 15 },
  { name: 'Sala Caballito', capacity: 12, hourlyRate: 40 },
  { name: 'Sala Flores', capacity: 6, hourlyRate: 20 },
  { name: 'Sala Boedo', capacity: 2, hourlyRate: 10 },
  { name: 'Auditorio Central', capacity: 30, hourlyRate: 80 },
  { name: 'Puesto Individual', capacity: 1, hourlyRate: 8 },
  { name: 'Sala Recoleta', capacity: 10, hourlyRate: 35 },
  { name: 'Sala Núñez', capacity: 5, hourlyRate: 18 },
  { name: 'Sala Saavedra', capacity: 3, hourlyRate: 12 },
];

const TOPE_LIBRO = 300;

/**
 * Lo que el simulador "sabe" del mundo: el catálogo de salas (se refresca
 * periódicamente) y las reservas que él mismo creó (el libro), que alimenta
 * al admin para avanzar estados y a los recorridos de errores esperados.
 */
export class SimState {
  salas: RoomResponse[] = [];

  private readonly libro = new Map<number, ReservationResponse>();
  private secuenciaSala = 0;

  get salasDisponibles(): RoomResponse[] {
    return this.salas.filter((r) => r.available);
  }

  registrarReserva(reserva: ReservationResponse): void {
    this.libro.set(reserva.id, reserva);
    if (this.libro.size > TOPE_LIBRO) {
      const primera = this.libro.keys().next().value;
      if (primera !== undefined) this.libro.delete(primera);
    }
  }

  /** Reservas más recientes conocidas (para el admin y el ruido controlado). */
  reservasRecientes(): ReservationResponse[] {
    return [...this.libro.values()];
  }

  siguienteNombreDeSala(runId: string): string {
    this.secuenciaSala += 1;
    return `Sala Sim ${runId}-${this.secuenciaSala}`;
  }

  catalogo(): Array<{ name: string; capacity: number; hourlyRate: number }> {
    return CATALOGO_SALAS;
  }
}
