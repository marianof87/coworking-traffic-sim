/**
 * Motor de simulación: fases, scheduleo de tráfico y ciclo de vida.
 *
 * Fases: salud → admin → siembra de salas → pool de usuarios →
 * [calentamiento] → medición → informe (el informe lo decide el CLI).
 *
 * - Modelo abierto (`--mode open`): las sesiones llegan como procesos de
 *   Poisson con la tasa `--rps` y toman un usuario del pool.
 * - Modelo cerrado (`--mode closed`): `--users` hilos en bucle con think time.
 */

import { ApiError } from '../api/errors.js';
import { ipVirtual, origen } from '../api/origen.js';
import { tasaEnEscalon } from '../config.js';
import type { ApiClient } from '../api/client.js';
import type { HealthResponse, RoomResponse } from '../api/types.js';
import type { Config } from '../config.js';
import type { MetricsCollector } from '../metrics/collector.js';
import { crearPersona, type Persona } from './personas.js';
import {
  describirFallo,
  seleccionarJourney,
  type JourneyContext,
} from './journeys.js';
import { UserPool } from './pool.js';
import { Rng } from './rng.js';
import { SimState } from './state.js';
import { VirtualUser } from './user.js';

/** Registro simultáneo de usuarios en la fase de aprovisionamiento. */
const PARALELISMO_ALTA = 5;

/** Tolerancia al drenado de peticiones en vuelo al terminar. */
const TOPE_DRENA_MS = 15_000;

export class Engine {
  private readonly rng: Rng;
  private pool = new UserPool([]);
  private admin: VirtualUser | null = null;
  private readonly enVuelo = new Set<Promise<void>>();
  private readonly cancelables = new Set<() => void>();
  private deteniendo = false;
  private contadorPersonas = 0;
  private refresco: NodeJS.Timeout | null = null;
  private etapa: 'preparacion' | 'calentamiento' | 'medicion' | 'fin' = 'preparacion';
  private inicioMedicion = 0;

  /** Etapa actual, para etiquetar el ticker en vivo (con el escalón, si hay). */
  get etapaActual(): string {
    return this.cfg.escalones && this.etapa === 'medicion'
      ? `medicion ${this.tasaActual()} ses/s`
      : this.etapa;
  }

  /** Sesiones/s objetivo ahora: fija, o la del escalón vigente (en calentamiento, el primero). */
  private tasaActual(): number {
    const { escalones } = this.cfg;
    if (!escalones) return this.cfg.rps;
    if (this.etapa !== 'medicion') return escalones[0] ?? this.cfg.rps;
    return tasaEnEscalon(escalones, Date.now() - this.inicioMedicion, this.cfg.durationMs);
  }

  /** Con --ips-virtuales, todo lo que haga `fn` sale con la IP de esa persona. */
  private comoUsuario<T>(email: string, fn: () => Promise<T>): Promise<T> {
    return this.cfg.ipsVirtuales ? origen.run(ipVirtual(email), fn) : fn();
  }

  constructor(
    private readonly cfg: Config,
    private readonly api: ApiClient,
    private readonly metrics: MetricsCollector,
    readonly state: SimState,
  ) {
    this.rng = new Rng(cfg.seed);
  }

  get hayAdmin(): boolean {
    return this.admin !== null;
  }

  async start(): Promise<void> {
    await this.probarSalud();
    await this.prepararAdmin();
    await this.sembrarSalas();
    await this.refrescarCatalogo();
    await this.proveerUsuarios();

    this.metrics.reset();
    this.refresco = setInterval(() => void this.refrescarCatalogo(), 30_000);
    this.refresco.unref();

    if (this.cfg.warmupMs > 0) {
      this.etapa = 'calentamiento';
      await this.fase(this.cfg.warmupMs);
      this.metrics.reset(); // que la ventana medida no cuente el calentamiento
    }
    this.etapa = 'medicion';
    this.inicioMedicion = Date.now();
    await this.fase(this.cfg.durationMs);
    this.etapa = 'fin';

    if (this.refresco) clearInterval(this.refresco);
    this.pool.liberarTodos();
  }

  /** Interrumpe el scheduleo y espera (corto) a lo que esté en vuelo. */
  async detener(): Promise<void> {
    if (this.deteniendo) return;
    this.deteniendo = true;
    for (const cancel of [...this.cancelables]) cancel();
    this.cancelables.clear();
    await this.drenar();
  }

  // ---------------------------------------------------------------------------
  // Fases y scheduleo
  // ---------------------------------------------------------------------------

  private async fase(ms: number): Promise<void> {
    this.deteniendo = false;
    const finDeFase = this.dormir(ms);
    if (this.cfg.mode === 'open') {
      this.programarLlegada();
    } else {
      this.arrancarTrabajadores();
    }
    await finDeFase;
    this.deteniendo = true;
    for (const cancel of [...this.cancelables]) cancel();
    this.cancelables.clear();
    await this.drenar();
  }

  /** Sleeper cancelable: al detener la simulación no se espera al timer. */
  private dormir(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const cancel = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.cancelables.delete(cancel);
        resolve();
      }, ms);
      this.cancelables.add(cancel);
    });
  }

  /** Modelo abierto: llegadas de Poisson (intervalo exponencial entre sesiones). */
  private programarLlegada(): void {
    if (this.deteniendo) return;
    const intervalo = Math.max(5, this.rng.exponential(1000 / this.tasaActual()));
    const cancel = (): void => clearTimeout(timer);
    const timer = setTimeout(() => {
      this.cancelables.delete(cancel);
      if (this.deteniendo) return;
      if (this.enVuelo.size < this.cfg.maxConcurrent) this.lanzarSesion();
      this.programarLlegada();
    }, intervalo);
    this.cancelables.add(cancel);
  }

  private lanzarSesion(): void {
    const promesa = (async () => {
      const user = await this.pool.acquire();
      try {
        // Al drenar al cierre, una sesión que esperaba por el pool no
        // empieza un recorrido nuevo: solo devuelve el usuario.
        if (this.deteniendo) return;
        await this.ejecutarRecorrido(user);
      } finally {
        this.pool.release(user);
      }
    })();
    this.enVuelo.add(promesa);
    void promesa.finally(() => this.enVuelo.delete(promesa));
  }

  /** Modelo cerrado: un "hilo" por usuario, en bucle hasta la señal de corte. */
  private arrancarTrabajadores(): void {
    for (let i = 0; i < this.cfg.users; i += 1) {
      void (async () => {
        const user = await this.pool.acquire();
        try {
          while (!this.deteniendo) {
            await this.ejecutarRecorrido(user);
            await this.dormir(this.rng.exponential(this.cfg.thinkTimeMs * 2) + 50);
          }
        } finally {
          this.pool.release(user);
        }
      })();
    }
  }

  private async ejecutarRecorrido(user: VirtualUser): Promise<void> {
    const journey = seleccionarJourney(this.rng, {
      chaos: this.cfg.chaos,
      adminDisponible: this.hayAdmin,
      mezcla: this.cfg.mezcla,
    });
    const ctx: JourneyContext = {
      api: this.api,
      user,
      admin: this.admin,
      rng: this.rng,
      state: this.state,
      metrics: this.metrics,
      runId: this.cfg.runId,
      diasMax: this.cfg.daysAhead,
      nuevaPersona: () => this.siguientePersona(),
      think: () => this.dormir(this.rng.exponential(this.cfg.thinkTimeMs) + 5),
    };

    try {
      await this.comoUsuario(user.persona.email, () => journey.run(ctx));
      this.metrics.registrarJourney(journey.name, true);
    } catch (err) {
      this.metrics.registrarJourney(journey.name, false, describirFallo(err));
    }
  }

  private async drenar(): Promise<void> {
    if (this.enVuelo.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.enVuelo]),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, TOPE_DRENA_MS);
        t.unref();
      }),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Preparación
  // ---------------------------------------------------------------------------

  private async probarSalud(): Promise<void> {
    let ultimoError: unknown = null;
    for (let intento = 0; intento < 3; intento += 1) {
      try {
        await this.api.get<HealthResponse>('/health');
        return;
      } catch (err) {
        ultimoError = err;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    throw new Error(
      `No se pudo contactar la API en ${this.cfg.baseUrl} (/health). ` +
        `¿Está corriendo el backend? Detalle: ${String(ultimoError)}`,
    );
  }

  private async prepararAdmin(): Promise<void> {
    const { adminEmail, adminPassword } = this.cfg;
    if (!adminEmail || !adminPassword) return;

    const admin = new VirtualUser(
      { nombre: 'Admin Simulador', email: adminEmail, password: adminPassword },
      this.api,
    );
    try {
      await admin.login();
      this.admin = admin;
    } catch {
      console.warn(
        `No se pudo iniciar sesión como ADMIN con ${adminEmail}: el tráfico seguirá sin altas de sala ni avance de estados.`,
      );
    }
  }

  /** Si faltan salas y hay admin, da de alta las del catálogo hasta `--seed-rooms`. */
  private async sembrarSalas(): Promise<void> {
    if (!this.admin || this.cfg.seedRooms === 0) return;

    const actuales = await this.api.get<RoomResponse[]>('/api/rooms');
    let creadas = 0;
    for (const modelo of this.state.catalogo()) {
      if (actuales.length + creadas >= this.cfg.seedRooms) break;
      try {
        const sala = await this.api.post<RoomResponse>('/api/rooms', modelo, {
          token: this.admin.requerirToken(),
        });
        this.state.salas.push(sala);
        creadas += 1;
      } catch (err) {
        // 409 "Room name already exists": otro run ya la creó; no es un fallo.
        if (err instanceof ApiError && err.status === 409) continue;
        throw err;
      }
    }
    if (creadas > 0) {
      console.log(`Salas creadas con el admin: ${creadas}`);
    }
  }

  private async refrescarCatalogo(): Promise<void> {
    try {
      this.state.salas = await this.api.get<RoomResponse[]>('/api/rooms');
    } catch {
      // Best-effort: si el refresco falla se sigue con el último catálogo.
    }
  }

  private siguientePersona(): Persona {
    this.contadorPersonas += 1;
    return crearPersona(this.rng, this.cfg.runId, this.contadorPersonas, this.cfg.simPassword);
  }

  /** Registra, loguea y carga saldo inicial al pool de usuarios virtuales. */
  private async proveerUsuarios(): Promise<void> {
    const fabricas = Array.from({ length: this.cfg.users }, () => {
      const persona = this.siguientePersona();
      return (): Promise<VirtualUser> =>
        this.comoUsuario(persona.email, async () => {
          const user = new VirtualUser(persona, this.api);
          await user.register();
          await user.login();
          await user.topUp(this.rng.int(200, 800));
          return user;
        });
    });

    const usuarios: VirtualUser[] = [];
    let fallos = 0;
    let primerError = '';
    for (let i = 0; i < fabricas.length; i += PARALELISMO_ALTA) {
      const lote = fabricas.slice(i, i + PARALELISMO_ALTA).map((f) => f());
      const resultados = await Promise.allSettled(lote);
      for (const resultado of resultados) {
        if (resultado.status === 'fulfilled') {
          usuarios.push(resultado.value);
        } else {
          fallos += 1;
          if (!primerError) primerError = String(resultado.reason);
        }
      }
    }

    if (usuarios.length === 0) {
      throw new Error(`No se pudo registrar ningún usuario virtual. Primer error: ${primerError}`);
    }
    if (fallos > 0) {
      console.warn(`${fallos} usuarios virtuales no pudieron darse de alta: ${primerError}`);
    }
    this.pool = new UserPool(usuarios);
    console.log(`Pool de usuarios virtuales listo: ${usuarios.length}/${this.cfg.users}`);
  }
}
