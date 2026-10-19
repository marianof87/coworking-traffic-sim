/** Generación de "personas" para los usuarios virtuales. */

import { Rng } from './rng.js';

export interface Persona {
  nombre: string;
  email: string;
  password: string;
}

const NOMBRES = [
  'Carla', 'Martín', 'Lucía', 'Santiago', 'Valentina', 'Facundo', 'Camila',
  'Nicolás', 'Julieta', 'Agustín', 'Sofía', 'Tomás', 'Micaela', 'Joaquín',
  'Paula', 'Ramiro', 'Delfina', 'Gonzalo', 'Marina', 'Ezequiel',
];

const APELLIDOS = [
  'Gómez', 'Pereyra', 'Álvarez', 'Ruiz', 'Ferreyra', 'Navarro', 'Acosta',
  'Medina', 'Herrera', 'Cabrera', 'Rivas', 'Ocampo', 'Villalba', 'Sosa',
  'Ledesma', 'Ibarra', 'Castro', 'Molina', 'Benítez', 'Quiroga',
];

/**
 * Crea una persona con email único por ejecución (`sim-<runId>-<n>`): así
 * varios runs consecutivos contra la misma base no chocan con 409
 * "Email already registered".
 */
export const crearPersona = (rng: Rng, runId: string, n: number, password: string): Persona => ({
  nombre: `${rng.pick(NOMBRES)} ${rng.pick(APELLIDOS)}`,
  email: `sim-${runId}-${n}@example.com`.toLowerCase(),
  password,
});

/** Body exacto que el backend espera en register (Zod `.strict()`). */
export const credenciales = (persona: Persona): { email: string; name: string; password: string } => ({
  email: persona.email,
  name: persona.nombre,
  password: persona.password,
});

/** El login NO lleva `name`: `loginSchema` es `.strict()` y lo rechazaría con 400. */
export const loginBody = (persona: Persona): { email: string; password: string } => ({
  email: persona.email,
  password: persona.password,
});
