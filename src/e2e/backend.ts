/**
 * Utilidades de las pruebas e2e: hablan con proyectoXP por HTTP, igual que el
 * simulador (caja negra: no importan nada del backend).
 *
 * Cada test crea sus propios datos (usuarios, sala nueva) con estas funciones;
 * no hay datos compartidos entre tests.
 */

import { randomUUID } from 'node:crypto';

import type { LoginResponse, RoomResponse, UserResponse } from '../api/types.js';

export const BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

/** Cuenta ADMIN de demostración que siembra el backend con ENABLE_SIMULATOR=true. */
const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? 'admin@coworking.demo',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'Admin1234!',
};

const PASSWORD = 'SimPass123!';

export interface Respuesta<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

interface Opciones {
  body?: unknown;
  token?: string;
  idempotencyKey?: string;
}

/** Petición cruda: devuelve status, cabeceras y body sin lanzar por 4xx/5xx. */
export const llamar = async <T = unknown>(
  method: string,
  path: string,
  { body, token, idempotencyKey }: Opciones = {},
): Promise<Respuesta<T>> => {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const texto = await res.text();
  return { status: res.status, headers: res.headers, body: (texto ? JSON.parse(texto) : undefined) as T };
};

/** Falla con un mensaje que dice qué paso de la preparación no funcionó. */
const exigir = <T>(r: Respuesta<T>, esperado: number, paso: string): T => {
  if (r.status !== esperado) {
    throw new Error(`Preparación "${paso}": se esperaba ${esperado} y llegó ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body;
};

// ---------------------------------------------------------------------------
// Rate limit: el backend limita por IP con ventana fija y lo informa en
// cabeceras X-RateLimit-*. Todas las pruebas comparten IP, así que antes de
// cada archivo se espera a tener cupo suficiente.
// ---------------------------------------------------------------------------

export interface Cupo {
  limite: number;
  restantes: number;
  /** Milisegundos hasta que la ventana se reinicia. */
  reiniciaEnMs: number;
}

export const leerCupo = (headers: Headers): Cupo => ({
  limite: Number(headers.get('x-ratelimit-limit')),
  restantes: Number(headers.get('x-ratelimit-remaining')),
  reiniciaEnMs: Number(headers.get('x-ratelimit-reset')) * 1000 - Date.now(),
});

/** Sondea el limitador general (todo /api) con una lectura pública. */
export const sondearGeneral = async (): Promise<Cupo> => leerCupo((await llamar('GET', '/api/rooms')).headers);

/**
 * Sondea el limitador de login/registro. El login pasa primero por el general
 * y después por el de auth, que sobrescribe las cabeceras: si responde 429 el
 * general, las cabeceras son las del general (por eso se sondea éste antes).
 */
export const sondearAuth = async (): Promise<Cupo> =>
  leerCupo((await llamar('POST', '/api/users/login', { body: { email: 'sondeo@example.com', password: 'x' } })).headers);

export const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Espera (como mucho una ventana por limitador) hasta tener el cupo pedido. */
export const esperarCupo = async ({ general = 0, auth = 0 }: { general?: number; auth?: number }): Promise<void> => {
  let cupo = await sondearGeneral();
  if (cupo.restantes < general + auth + 2) {
    await dormir(cupo.reiniciaEnMs + 500);
  }
  if (auth > 0) {
    cupo = await sondearAuth();
    if (cupo.restantes < auth) await dormir(cupo.reiniciaEnMs + 500);
  }
};

// ---------------------------------------------------------------------------
// Datos realistas: cada llamada crea entidades nuevas con nombres plausibles.
// ---------------------------------------------------------------------------

const NOMBRES = ['Lucía Medina', 'Tomás Herrera', 'Julieta Sosa', 'Ramiro Acosta', 'Delfina Ruiz', 'Gonzalo Ibarra'];
const BARRIOS = ['Palermo', 'Almagro', 'Villa Crespo', 'Colegiales', 'Chacarita', 'Parque Patricios'];

const sufijo = (): string => randomUUID().slice(0, 8);
const elegir = <T>(lista: readonly T[]): T => lista[Math.floor(Math.random() * lista.length)] as T;

export interface UsuarioE2E {
  id: number;
  token: string;
  email: string;
}

/** Registra, inicia sesión y (opcionalmente) recarga saldo: 2 o 3 peticiones (2 de auth). */
export const crearUsuario = async (saldo = 0): Promise<UsuarioE2E> => {
  const nombre = elegir(NOMBRES);
  const email = `${nombre.toLowerCase().replace(/\s+/g, '.')}.${sufijo()}@example.com`;
  exigir(await llamar('POST', '/api/users/register', { body: { email, name: nombre, password: PASSWORD } }), 201, 'registro');
  const { token, user } = exigir(
    await llamar<LoginResponse>('POST', '/api/users/login', { body: { email, password: PASSWORD } }),
    200,
    'login',
  );
  if (saldo > 0) {
    exigir(await llamar('POST', `/api/users/${user.id}/balance`, { body: { amount: saldo }, token }), 200, 'recarga');
  }
  return { id: user.id, token, email };
};

export const loginAdmin = async (): Promise<string> =>
  exigir(await llamar<LoginResponse>('POST', '/api/users/login', { body: ADMIN }), 200, 'login del ADMIN').token;

/** Sala recién creada: ninguna otra prueba ni corrida del simulador la conoce. */
export const crearSala = async (adminToken: string, hourlyRate: number): Promise<RoomResponse> =>
  exigir(
    await llamar<RoomResponse>('POST', '/api/rooms', {
      token: adminToken,
      body: { name: `Sala ${elegir(BARRIOS)} e2e-${sufijo()}`, capacity: 6, hourlyRate },
    }),
    201,
    'alta de sala',
  );

export const saldoDe = async (usuario: UsuarioE2E): Promise<number> =>
  exigir(await llamar<UserResponse>('GET', '/api/users/me', { token: usuario.token }), 200, 'perfil').balance;

/** Franja de `horas` horas, `dias` días en el futuro, a las `hora` UTC. */
export const franja = (dias: number, hora: number, horas = 1): { startDate: string; endDate: string } => {
  const inicio = new Date();
  inicio.setUTCDate(inicio.getUTCDate() + dias);
  inicio.setUTCHours(hora, 0, 0, 0);
  const fin = new Date(inicio.getTime() + horas * 3_600_000);
  return { startDate: inicio.toISOString(), endDate: fin.toISOString() };
};

/** Cuenta cuántas respuestas hubo de cada status: `{ 201: 1, 409: 3 }`. */
export const contarEstados = (respuestas: ReadonlyArray<{ status: number }>): Record<number, number> =>
  respuestas.reduce<Record<number, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
