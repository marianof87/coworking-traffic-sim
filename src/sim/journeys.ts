/**
 * Recorridos (journeys): flujos completos de usuario contra la API.
 *
 * Cada recorrido simula el comportamiento de una persona real: mira el
 * catálogo, consulta disponibilidad, recarga si le falta saldo, reserva,
 * cancela o administra. Respeta las reglas del backend (HU-01…HU-11) y solo
 * ejercita errores 4xx a propósito en los recorridos marcados `chaos`,
 * donde ese error ES el resultado esperado.
 */

import { ApiError, esperarEstado } from '../api/errors.js';
import type { ApiClient } from '../api/client.js';
import type {
  AvailabilityResponse,
  ReservationResponse,
  RoomResponse,
} from '../api/types.js';
import type { MetricsCollector } from '../metrics/collector.js';
import type { Persona } from './personas.js';
import type { Rng } from './rng.js';
import type { SimState } from './state.js';
import { elegirSlotFuturo, horasDe, type Slot } from './slots.js';
import { VirtualUser } from './user.js';

export interface JourneyContext {
  api: ApiClient;
  user: VirtualUser;
  admin: VirtualUser | null;
  rng: Rng;
  state: SimState;
  metrics: MetricsCollector;
  runId: string;
  /** Horizonte de reserva (días hacia adelante): amplía el espacio de slots. */
  diasMax: number;
  /** Fábrica de personas nuevas (para el recorrido de alta de usuario). */
  nuevaPersona: () => Persona;
  /** "Think time" entre pasos: nadie hace click a velocidad de máquina. */
  think: () => Promise<void>;
}

export interface Journey {
  name: string;
  /** Peso relativo en la mezcla de tráfico. */
  weight: number;
  /** Errores 4xx esperados: se desactivan con --no-chaos. */
  chaos?: boolean;
  /** Requiere un ADMIN configurado; se omite si no lo hay. */
  adminOnly?: boolean;
  run(ctx: JourneyContext): Promise<void>;
}

interface Elegida {
  room: RoomResponse;
  slot: Slot;
}

// ---------------------------------------------------------------------------
// Helpers compartidos
// ---------------------------------------------------------------------------

/**
 * Elige sala + franja y confirma disponibilidad (como haría una persona):
 * hasta 3 intentos; si las salas están tomadas, el usuario se va sin reservar.
 */
const elegirSalaYSlot = async (ctx: JourneyContext): Promise<Elegida | null> => {
  const candidatas = ctx.state.salasDisponibles;
  const lista = candidatas.length > 0 ? candidatas : ctx.state.salas;
  if (lista.length === 0) return null;

  for (let intento = 0; intento < 3; intento += 1) {
    const room = ctx.rng.pick(lista);
    const slot = elegirSlotFuturo(ctx.rng, ctx.diasMax);
    await ctx.think();
    const disponibilidad = await ctx.api.post<AvailabilityResponse>(
      `/api/rooms/${room.id}/check-availability`,
      { startDate: slot.start.toISOString(), endDate: slot.end.toISOString() },
    );
    if (disponibilidad.isAvailable) return { room, slot };
  }
  return null;
};

/** Coste esperado: el backend cobra horas × tarifa horaria. */
const precioDe = (elegida: Elegida): number => horasDe(elegida.slot) * elegida.room.hourlyRate;

/** Si no alcanza el saldo, recarga antes de reservar (como haría cualquier usuario). */
const asegurarSaldo = async (ctx: JourneyContext, costo: number): Promise<void> => {
  await ctx.user.refreshProfile();
  if (ctx.user.saldo < costo) {
    const recarga = Math.ceil(costo * (1 + ctx.rng.next())) + 50;
    await ctx.user.topUp(recarga);
    ctx.metrics.kpi.recargas += 1;
    await ctx.think();
  }
};

/** Reserva la sala/franja elegidas, con clave de idempotencia opcional (HU-11). */
const reservar = async (
  ctx: JourneyContext,
  elegida: Elegida,
  idempotencyKey?: string,
): Promise<ReservationResponse> => {
  const reserva = await ctx.api.post<ReservationResponse>(
    '/api/reservations',
    {
      userId: ctx.user.id,
      roomId: elegida.room.id,
      startDate: elegida.slot.start.toISOString(),
      endDate: elegida.slot.end.toISOString(),
    },
    {
      token: ctx.user.requerirToken(),
      idempotencyKey,
    },
  );
  ctx.metrics.kpi.reservasCreadas += 1;
  ctx.metrics.kpi.montoReservado += reserva.totalCost;
  ctx.state.registrarReserva(reserva);
  return reserva;
};

const TOPE_INTENTOS_RESERVA = 3;

/**
 * Flujo completo de reserva con reintentos: si entre el check de
 * disponibilidad y la reserva otro usuario virtual se adelantó (409), la
 * persona real probaría con otra franja; si se le adelantaron en todas, se
 * va sin reservar. El 409 ya queda registrado en las métricas del endpoint.
 *
 * La clave de idempotencia se genera una sola vez: un reintento por 409
 * nunca llegó a crear reserva (la clave no se guardó), así que reutilizarla
 * es correcto y permite verificar la idempotencia con la clave buena.
 */
const reservarConReintentos = async (
  ctx: JourneyContext,
  conClave: boolean,
): Promise<{ reserva: ReservationResponse; elegida: Elegida; clave?: string } | null> => {
  const clave = conClave ? `sim-${ctx.runId}-${ctx.rng.uuid()}` : undefined;

  for (let intento = 0; intento < TOPE_INTENTOS_RESERVA; intento += 1) {
    const elegida = await elegirSalaYSlot(ctx);
    if (!elegida) return null;

    await asegurarSaldo(ctx, precioDe(elegida));
    try {
      const reserva = await reservar(ctx, elegida, clave);
      return { reserva, elegida, clave };
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await ctx.think();
        continue;
      }
      throw err;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Recorridos
// ---------------------------------------------------------------------------

/** Navegación read-only: el usuario mira catálogo y perfil (el flujo más común). */
const consultaPublica: Journey = {
  name: 'consulta-publica',
  weight: 20,
  async run(ctx) {
    await ctx.user.ensureSession();
    await ctx.think();

    const salas = await ctx.api.get<RoomResponse[]>('/api/rooms');
    if (salas.length > 0 && ctx.rng.chance(0.6)) {
      await ctx.think();
      await ctx.api.get<RoomResponse>(`/api/rooms/${ctx.rng.pick(salas).id}`);
    }
    if (salas.length > 0 && ctx.rng.chance(0.4)) {
      await ctx.think();
      const slot = elegirSlotFuturo(ctx.rng, ctx.diasMax);
      await ctx.api.post<AvailabilityResponse>(
        `/api/rooms/${ctx.rng.pick(salas).id}/check-availability`,
        { startDate: slot.start.toISOString(), endDate: slot.end.toISOString() },
      );
    }
    await ctx.think();
    await ctx.api.get('/api/users/me', { token: ctx.user.requerirToken() });
  },
};

/** Flujo principal de negocio: mirar, verificar disponibilidad y reservar. */
const reservaSimple: Journey = {
  name: 'reserva-simple',
  weight: 26,
  async run(ctx) {
    await ctx.user.ensureSession();
    await ctx.think();

    const resultado = await reservarConReintentos(ctx, ctx.rng.chance(0.3));
    if (!resultado) return; // sin disponibilidad: el usuario se va (sin error)

    await ctx.think();
    await ctx.user.myReservations();
  },
};

/** Reserva y, segundos después, se arrepiente: cancelación con reembolso (HU-06). */
const reservaYCancela: Journey = {
  name: 'reserva-y-cancela',
  weight: 14,
  async run(ctx) {
    await ctx.user.ensureSession();
    await ctx.think();

    const resultado = await reservarConReintentos(ctx, false);
    if (!resultado) return;

    await ctx.think();
    await ctx.think();
    const cancelada = await ctx.api.delete<ReservationResponse>(
      `/api/reservations/${resultado.reserva.id}`,
      { token: ctx.user.requerirToken() },
    );
    ctx.metrics.kpi.reservasCanceladas += 1;
    ctx.metrics.kpi.montoReembolsado += cancelada.totalCost;
    ctx.state.registrarReserva(cancelada);
  },
};

/** Ciclo de vida de la cuenta: perfil, recarga, historial y re-login (HU-11 logout). */
const gestionCuenta: Journey = {
  name: 'gestion-cuenta',
  weight: 12,
  async run(ctx) {
    await ctx.user.ensureSession();
    await ctx.user.refreshProfile();
    await ctx.think();

    await ctx.user.topUp(ctx.rng.int(100, 400));
    ctx.metrics.kpi.recargas += 1;
    await ctx.think();

    await ctx.user.myReservations();
    await ctx.think();

    // De vez en cuando cierra sesión y vuelve a entrar: ejercita el logout
    // (revocación de jti) y un login nuevo con token distinto.
    if (ctx.rng.chance(0.35)) {
      await ctx.user.logout();
      await ctx.think();
      await ctx.user.login();
      ctx.metrics.kpi.logins += 1;
      await ctx.user.refreshProfile();
    }
  },
};

/**
 * Reintento idempotente (HU-11, Actividad B): la misma petición con la misma
 * clave debe devolver la MISMA reserva, sin cobrar dos veces.
 */
const reintentoIdempotente: Journey = {
  name: 'reintento-idempotente',
  weight: 7,
  async run(ctx) {
    await ctx.user.ensureSession();
    await ctx.think();

    // Una sola clave para todo el recorrido: el reintento debe repetir la
    // MISMA petición con la MISMA clave (HU-11).
    const resultado = await reservarConReintentos(ctx, true);
    if (!resultado) return;
    const { reserva: primera, elegida, clave } = resultado;

    await ctx.think();
    const repetida = await ctx.api.post<ReservationResponse>(
      '/api/reservations',
      {
        userId: ctx.user.id,
        roomId: elegida.room.id,
        startDate: elegida.slot.start.toISOString(),
        endDate: elegida.slot.end.toISOString(),
      },
      { token: ctx.user.requerirToken(), idempotencyKey: clave },
    );

    if (repetida.id !== primera.id) {
      // El backend creó una reserva nueva en lugar de devolver la primera:
      // la idempotencia está rota. Falla el recorrido a propósito.
      throw new Error(`idempotencia rota: reserva ${primera.id} vs ${repetida.id}`);
    }
    // No suma KPI ni libro: la "segunda" no es una reserva nueva.

    await ctx.think();
    await ctx.user.myReservations();
  },
};

/** Alta de una cuenta nueva (HU-01): registro público + login + recarga inicial. */
const altaUsuario: Journey = {
  name: 'alta-usuario',
  weight: 6,
  async run(ctx) {
    const nuevo = new VirtualUser(ctx.nuevaPersona(), ctx.api);
    await nuevo.register();
    await ctx.think();
    await nuevo.login();
    ctx.metrics.kpi.logins += 1;
    await ctx.think();
    await nuevo.topUp(ctx.rng.int(150, 600));
    ctx.metrics.kpi.recargas += 1;
  },
};

/** Personal administrativo: altas de sala y avance de estados (HU-05 + HU-11). */
const adminPersonal: Journey = {
  name: 'admin-personal',
  weight: 5,
  adminOnly: true,
  async run(ctx) {
    const admin = ctx.admin;
    if (!admin) return;
    await admin.ensureSession();
    await ctx.think();

    // De vez en cuando se da de alta una sala nueva.
    if (ctx.rng.chance(0.25)) {
      const sala = await ctx.api.post<RoomResponse>(
        '/api/rooms',
        {
          name: ctx.state.siguienteNombreDeSala(ctx.runId),
          description: 'Alta desde el simulador de tráfico',
          capacity: ctx.rng.int(2, 12),
          hourlyRate: ctx.rng.int(2, 16) * 5,
        },
        { token: admin.requerirToken() },
      );
      ctx.state.salas.push(sala);
      await ctx.think();
    }

    // Avanza la máquina de estados de reservas conocidas
    // (CONFIRMED → IN_PROGRESS → COMPLETED; HU-11).
    const reservas = ctx.state.reservasRecientes();
    const paraCompletar = reservas.find((r) => r.status === 'IN_PROGRESS');
    if (paraCompletar && ctx.rng.chance(0.7)) {
      const completada = await ctx.api.patch<ReservationResponse>(
        `/api/reservations/${paraCompletar.id}/status`,
        { status: 'COMPLETED' },
        { token: admin.requerirToken() },
      );
      ctx.metrics.kpi.reservasCompletadas += 1;
      ctx.state.registrarReserva(completada);
      await ctx.think();
    }

    const paraIniciar = reservas.find((r) => r.status === 'CONFIRMED');
    if (paraIniciar && ctx.rng.chance(0.7)) {
      const enCurso = await ctx.api.patch<ReservationResponse>(
        `/api/reservations/${paraIniciar.id}/status`,
        { status: 'IN_PROGRESS' },
        { token: admin.requerirToken() },
      );
      ctx.state.registrarReserva(enCurso);
    }

    await ctx.api.get('/api/rooms');
  },
};

/** Login con contraseña equivocada: el backend responde 401 genérico (HU-08). */
const loginInvalido: Journey = {
  name: 'login-invalido',
  weight: 3,
  chaos: true,
  async run(ctx) {
    try {
      await ctx.api.post('/api/users/login', {
        email: ctx.user.persona.email,
        password: 'contrasena-equivocada',
      });
      throw new Error('el login con contraseña incorrecta debió fallar');
    } catch (err) {
      esperarEstado(err, 401);
    }
    ctx.metrics.kpi.loginsFallidos += 1;
  },
};

/**
 * Errores que un usuario legítimo provoca sin querer (o un curioso):
 * todos responden 4xx por diseño (HU-08/09/10). Que un 4xx acá sea "ok"
 * es parte del contrato de la API, no un fallo del backend.
 */
const ruidoLegitimo: Journey = {
  name: 'ruido-legitimo',
  weight: 5,
  chaos: true,
  async run(ctx) {
    const { api, user, rng } = ctx;
    await user.ensureSession();
    const token = user.requerirToken();
    await ctx.think();

    // Usuario inexistente → 404
    try {
      await api.get('/api/users/999999');
      throw new Error('esperaba 404 para un usuario inexistente');
    } catch (err) {
      esperarEstado(err, 404);
    }
    await ctx.think();

    // Un USER intentando crear sala → 403 (RBAC, HU-09)
    try {
      await api.post(
        '/api/rooms',
        {
          name: `No debe crearse ${rng.uuid()}`,
          capacity: 1,
          hourlyRate: 10,
        },
        { token },
      );
      throw new Error('esperaba 403 al crear sala sin rol ADMIN');
    } catch (err) {
      esperarEstado(err, 403);
    }
    await ctx.think();

    // Recarga con monto no positivo → 400 (validación de negocio, HU-02)
    try {
      await api.post(`/api/users/${user.id}/balance`, { amount: -50 }, { token });
      throw new Error('esperaba 400 para un monto no positivo');
    } catch (err) {
      esperarEstado(err, 400);
    }
    await ctx.think();

    // Petición sin token a ruta protegida → 401 (HU-09)
    try {
      await api.get('/api/users/me');
      throw new Error('esperaba 401 sin token');
    } catch (err) {
      esperarEstado(err, 401);
    }
    await ctx.think();

    // Reservar un tramo que el propio usuario ya tiene reservado → 409 (solapamiento, HU-03)
    const propia = ctx.state
      .reservasRecientes()
      .find((r) => r.userId === user.id && r.status === 'CONFIRMED');
    if (propia) {
      try {
        await api.post(
          '/api/reservations',
          {
            userId: user.id,
            roomId: propia.roomId,
            startDate: propia.startDate,
            endDate: propia.endDate,
          },
          { token },
        );
        throw new Error('esperaba 409 por solapamiento');
      } catch (err) {
        esperarEstado(err, 409);
      }
    }

    ctx.metrics.kpi.erroresSimulados += 1;
  },
};

/** Mezcla por defecto de tráfico. */
export const RECORRIDOS: Journey[] = [
  consultaPublica,
  reservaSimple,
  reservaYCancela,
  gestionCuenta,
  reintentoIdempotente,
  altaUsuario,
  adminPersonal,
  loginInvalido,
  ruidoLegitimo,
];

export interface SeleccionOptions {
  chaos: boolean;
  adminDisponible: boolean;
}

/** Selección ponderada respetando los filtros (chaos/admin). */
export const seleccionarJourney = (rng: Rng, opciones: SeleccionOptions): Journey => {
  const elegibles = RECORRIDOS.filter(
    (j) =>
      (opciones.chaos || !j.chaos) &&
      (opciones.adminDisponible || !j.adminOnly),
  );
  if (elegibles.length === 0) throw new Error('No hay recorridos elegibles');
  const pesoTotal = elegibles.reduce((acc, j) => acc + j.weight, 0);
  let sorteo = rng.next() * pesoTotal;
  for (const j of elegibles) {
    sorteo -= j.weight;
    if (sorteo <= 0) return j;
  }
  return elegibles[elegibles.length - 1] as Journey;
};

/** Descripción corta del fallo de un recorrido, para el informe. */
export const describirFallo = (err: unknown): string => {
  if (err instanceof Error) {
    const mensaje = err.message.replace(/\s+/g, ' ').trim();
    return mensaje.length > 80 ? `${mensaje.slice(0, 77)}…` : mensaje || err.name;
  }
  return String(err);
};
