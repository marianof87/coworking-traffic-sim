/**
 * Modo `smoke`: recorre los 15 endpoints del backend de punta a punta con un
 * solo usuario, verificando respuestas y reglas de negocio básicas.
 *
 * Sirve para validar la conectividad y el contrato ANTES de aplicar carga.
 */

import { ApiError } from './api/errors.js';
import { ApiClient } from './api/client.js';
import type {
  AvailabilityResponse,
  HealthResponse,
  LoginResponse,
  ReservationResponse,
  RoomResponse,
  UserResponse,
} from './api/types.js';
import type { Config } from './config.js';
import { credenciales, loginBody } from './sim/personas.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

export const runSmoke = async (cfg: Config): Promise<boolean> => {
  let fallos = 0;

  const api = new ApiClient(cfg.baseUrl, () => undefined, cfg.timeoutMs);

  const paso = async (nombre: string, fn: () => Promise<string>): Promise<boolean> => {
    const t0 = performance.now();
    try {
      const detalle = await fn();
      console.log(
        `  ${GREEN}✓${RESET} ${nombre.padEnd(56)} ${DIM}${(performance.now() - t0).toFixed(0)} ms${RESET}` +
          (detalle ? `  ${DIM}${detalle}${RESET}` : ''),
      );
      return true;
    } catch (err) {
      fallos += 1;
      const mensaje = err instanceof ApiError
        ? `${err.status} ${err.serverMessage}`
        : err instanceof Error
          ? err.message
          : String(err);
      console.log(`  ${RED}✗${RESET} ${nombre.padEnd(56)} ${RED}${mensaje}${RESET}`);
      return false;
    }
  };

  const verificar = (condicion: boolean, mensaje: string): void => {
    if (!condicion) throw new Error(mensaje);
  };

  console.log(`${BOLD}Smoke test contra ${cfg.baseUrl}${RESET} ${DIM}(run ${cfg.runId})${RESET}\n`);

  // Estado general ----------------------------------------------------------
  let token = '';
  let userId = 0;
  let balanceTrasRecarga = 0;
  let sala: RoomResponse | null = null;
  let reservaId = 0;
  let adminToken = '';

  await paso('GET /health', async () => {
    const h = await api.get<HealthResponse>('/health');
    verificar(h.status === 'OK', `status inesperado: ${h.status}`);
    return `status ${h.status}`;
  });

  // Usuarios ----------------------------------------------------------------
  const persona = {
    nombre: 'Usuario Smoke',
    email: `smoke-${cfg.runId}@example.com`.toLowerCase(),
    password: cfg.simPassword,
  };

  await paso('POST /api/users/register (201, saldo 0)', async () => {
    const u = await api.post<UserResponse>('/api/users/register', credenciales(persona));
    userId = u.id;
    verificar(u.id > 0, 'id inválido');
    verificar(u.balance === 0, `saldo inicial inesperado: ${u.balance}`);
    return `id ${u.id}`;
  });

  await paso('POST /api/users/login (token JWT)', async () => {
    const l = await api.post<LoginResponse>('/api/users/login', loginBody(persona));
    token = l.token;
    verificar(l.token.length > 20, 'token demasiado corto');
    return `user ${l.user.id}`;
  });

  await paso('GET /api/users/me (perfil del token)', async () => {
    const u = await api.get<UserResponse>('/api/users/me', { token });
    verificar(u.email === persona.email, `email distinto: ${u.email}`);
    return u.email;
  });

  await paso('GET /api/users/:id (público)', async () => {
    const u = await api.get<UserResponse>(`/api/users/${userId}`);
    verificar(u.id === userId, 'id distinto');
    return `rol ${u.role}`;
  });

  await paso('GET /api/users/me sin token → 401', async () => {
    try {
      await api.get('/api/users/me');
      throw new Error('debía fallar sin token');
    } catch (err) {
      verificar(err instanceof ApiError && err.status === 401, `status inesperado: ${err instanceof ApiError ? err.status : err}`);
    }
    return '401 confirmado';
  });

  await paso('POST /api/users/:id/balance +500', async () => {
    const u = await api.post<UserResponse>(
      `/api/users/${userId}/balance`,
      { amount: 500 },
      { token },
    );
    balanceTrasRecarga = u.balance;
    verificar(Math.abs(u.balance - 500) < 0.01, `saldo inesperado: ${u.balance}`);
    return `saldo ${u.balance}`;
  });

  // Salas -------------------------------------------------------------------
  await paso('GET /api/rooms (catálogo)', async () => {
    const salas = await api.get<RoomResponse[]>('/api/rooms');
    sala = salas.length > 0 ? (salas[0] as RoomResponse) : null;
    return `${salas.length} salas`;
  });

  if (cfg.adminEmail && cfg.adminPassword) {
    await paso('Login del ADMIN configurado', async () => {
      const l = await api.post<LoginResponse>('/api/users/login', {
        email: cfg.adminEmail,
        password: cfg.adminPassword,
      });
      adminToken = l.token;
      verificar(l.user.role === 'ADMIN', `rol inesperado: ${l.user.role}`);
      return `admin ${l.user.id}`;
    });

    await paso('POST /api/rooms (alta de sala, solo ADMIN)', async () => {
      const creada = await api.post<RoomResponse>(
        '/api/rooms',
        {
          name: `Sala Smoke ${cfg.runId}`,
          description: 'Alta del smoke test',
          capacity: 6,
          hourlyRate: 20,
        },
        { token: adminToken },
      );
      sala = creada;
      return `${creada.name} (id ${creada.id})`;
    });
  }

  if (!sala) {
    console.log(
      `  ${YELLOW}!${RESET} No hay salas disponibles y no se configuró ADMIN: se omiten los pasos de reserva.`,
    );
    console.log(
      `  ${YELLOW}!${RESET} Tip: crear un ADMIN en la BD y exportar ADMIN_EMAIL / ADMIN_PASSWORD (ver .env.example).`,
    );
  }

  // Reservas ----------------------------------------------------------------
  if (sala) {
    const salaElegida = sala as RoomResponse;

    const slot = { start: new Date(), end: new Date() };
    slot.start.setDate(slot.start.getDate() + 1);
    slot.start.setHours(10, 0, 0, 0);
    slot.end = new Date(slot.start.getTime() + 3_600_000);

    await paso('POST /api/rooms/:id/check-availability', async () => {
      const a = await api.post<AvailabilityResponse>(
        `/api/rooms/${salaElegida.id}/check-availability`,
        { startDate: slot.start.toISOString(), endDate: slot.end.toISOString() },
      );
      return `isAvailable=${a.isAvailable}`;
    });

    const cuerpoReserva = {
      userId,
      roomId: salaElegida.id,
      startDate: slot.start.toISOString(),
      endDate: slot.end.toISOString(),
    };
    const clave = `smoke-${cfg.runId}`;
    let costoEsperado = 0;

    await paso('POST /api/reservations con X-Idempotency-Key (201, CONFIRMED)', async () => {
      const r = await api.post<ReservationResponse>('/api/reservations', cuerpoReserva, {
        token,
        idempotencyKey: clave,
      });
      reservaId = r.id;
      costoEsperado = salaElegida.hourlyRate; // 1 hora
      verificar(r.status === 'CONFIRMED', `estado inesperado: ${r.status}`);
      verificar(Math.abs(r.totalCost - costoEsperado) < 0.01, `coste inesperado: ${r.totalCost}`);
      return `reserva ${r.id}, coste ${r.totalCost}`;
    });

    await paso('Repetir la misma petición → misma reserva (idempotencia)', async () => {
      const r = await api.post<ReservationResponse>('/api/reservations', cuerpoReserva, {
        token,
        idempotencyKey: clave,
      });
      verificar(r.id === reservaId, `ids distintos: ${r.id} vs ${reservaId} (idempotencia rota)`);
      return `misma reserva ${r.id}`;
    });

    await paso('Saldo descontado exactamente una vez', async () => {
      const u = await api.get<UserResponse>('/api/users/me', { token });
      const esperado = balanceTrasRecarga - costoEsperado;
      verificar(Math.abs(u.balance - esperado) < 0.01, `saldo ${u.balance}, esperaba ${esperado}`);
      return `saldo ${u.balance}`;
    });

    await paso('GET /api/users/:userId/reservations (historial propio)', async () => {
      const rs = await api.get<ReservationResponse[]>(`/api/users/${userId}/reservations`, {
        token,
      });
      verificar(rs.some((r) => r.id === reservaId), 'la reserva no aparece en el historial');
      return `${rs.length} reservas`;
    });

    await paso('DELETE /api/reservations/:id → CANCELLED + reembolso', async () => {
      const r = await api.delete<ReservationResponse>(`/api/reservations/${reservaId}`, {
        token,
      });
      verificar(r.status === 'CANCELLED', `estado inesperado: ${r.status}`);
      const u = await api.get<UserResponse>('/api/users/me', { token });
      verificar(Math.abs(u.balance - balanceTrasRecarga) < 0.01, `saldo tras reembolso: ${u.balance}`);
      return `reembolsado ${r.totalCost}`;
    });

    // Ciclo de estados con admin (HU-11)
    if (adminToken) {
      let reservaAdmin = 0;
      await paso('POST /api/reservations (segunda reserva, para el ciclo de estados)', async () => {
        const r = await api.post<ReservationResponse>(
          '/api/reservations',
          {
            userId,
            roomId: salaElegida.id,
            startDate: slot.start.toISOString(),
            endDate: slot.end.toISOString(),
          },
          { token },
        );
        reservaAdmin = r.id;
        return `reserva ${r.id}`;
      });

      await paso('PATCH /api/reservations/:id/status → IN_PROGRESS', async () => {
        const r = await api.patch<ReservationResponse>(
          `/api/reservations/${reservaAdmin}/status`,
          { status: 'IN_PROGRESS' },
          { token: adminToken },
        );
        verificar(r.status === 'IN_PROGRESS', `estado inesperado: ${r.status}`);
        return r.status;
      });

      await paso('PATCH → COMPLETED (y saltarse pasos responde 409)', async () => {
        const r = await api.patch<ReservationResponse>(
          `/api/reservations/${reservaAdmin}/status`,
          { status: 'COMPLETED' },
          { token: adminToken },
        );
        verificar(r.status === 'COMPLETED', `estado inesperado: ${r.status}`);
        try {
          await api.patch(
            `/api/reservations/${reservaAdmin}/status`,
            { status: 'IN_PROGRESS' },
            { token: adminToken },
          );
          throw new Error('una reserva COMPLETED no debía poder retroceder');
        } catch (err) {
          verificar(err instanceof ApiError && err.status === 409, `status inesperado: ${err instanceof ApiError ? err.status : err}`);
        }
        return '409 en transición inválida confirmado';
      });
    } else {
      console.log(`  ${YELLOW}!${RESET} Sin ADMIN: se omite el ciclo CONFIRMED → IN_PROGRESS → COMPLETED.`);
    }
  }

  // Sesiones ----------------------------------------------------------------
  await paso('POST /api/users/logout (204) y token viejo → 401', async () => {
    await api.post<void>('/api/users/logout', undefined, { token });
    try {
      await api.get('/api/users/me', { token });
      throw new Error('el token revocado debía dar 401');
    } catch (err) {
      verificar(err instanceof ApiError && err.status === 401, `status inesperado: ${err instanceof ApiError ? err.status : err}`);
    }
    return 'revocación confirmada';
  });

  console.log('');
  if (fallos === 0) {
    console.log(`${GREEN}${BOLD}Smoke OK${RESET}: el backend responde según el contrato.`);
    return true;
  }
  console.log(`${RED}${BOLD}Smoke con ${fallos} fallo(s)${RESET}: revisar los pasos marcados con ✗.`);
  return false;
};
