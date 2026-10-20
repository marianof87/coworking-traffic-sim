/** Configuración del simulador: flags de CLI + variables de entorno. */

export interface Config {
  baseUrl: string;
  /** Duración de la ventana medida. */
  durationMs: number;
  warmupMs: number;
  /** `open`: llegadas a una tasa (rps). `closed`: N usuarios en bucle. */
  mode: 'open' | 'closed';
  rps: number;
  users: number;
  maxConcurrent: number;
  thinkTimeMs: number;
  seed: number;
  /** Identificador de la corrida (emails únicos, nombres de sala, informes). */
  runId: string;
  chaos: boolean;
  adminEmail: string | null;
  adminPassword: string | null;
  /** Salas a crear con el admin si el catálogo tiene menos (0 = no crear). */
  seedRooms: number;
  /** Horizonte de reserva en días: define junto a las salas el espacio de slots. */
  daysAhead: number;
  reportIntervalMs: number;
  timeoutMs: number;
  outDir: string;
  /** Contraseña de los usuarios virtuales (el backend exige ≥ 8 caracteres). */
  simPassword: string;
}

/** Acepta `90`, `90s`, `2m`, `1h`. Devuelve milisegundos. */
export const parseDuration = (value: string): number => {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(value.trim());
  if (!match) throw new Error(`Duración inválida: "${value}" (usa 90, 90s, 2m, 1h)`);
  const cantidad = Number.parseFloat(match[1] ?? '0');
  const unidad = (match[2] ?? 's').toLowerCase();
  const factores: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const factor = factores[unidad] ?? 1000;
  return Math.round(cantidad * factor);
};

export interface CliOptions {
  baseUrl?: string;
  duration?: string;
  rps?: string;
  mode?: string;
  users?: string;
  maxConcurrent?: string;
  thinkTime?: string;
  warmup?: string;
  seed?: string;
  chaos?: boolean;
  adminEmail?: string;
  adminPassword?: string;
  seedRooms?: string;
  daysAhead?: string;
  reportInterval?: string;
  timeout?: string;
  out?: string;
  simPassword?: string;
}

const num = (value: string | undefined, defecto: number, etiqueta: string): number => {
  if (value === undefined) return defecto;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error(`${etiqueta}: "${value}" no es un número`);
  return parsed;
};

export const buildConfig = (opts: CliOptions, env: NodeJS.ProcessEnv): Config => {
  const seed = num(opts.seed, 42, '--seed');
  const baseUrl = (opts.baseUrl ?? env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  const mode = (opts.mode ?? 'open').toLowerCase();
  if (mode !== 'open' && mode !== 'closed') {
    throw new Error(`--mode debe ser "open" o "closed" (recibido: "${mode}")`);
  }

  const adminEmail = opts.adminEmail ?? env.ADMIN_EMAIL ?? '';
  const adminPassword = opts.adminPassword ?? env.ADMIN_PASSWORD ?? '';

  return {
    baseUrl,
    durationMs: parseDuration(opts.duration ?? '60s'),
    warmupMs: parseDuration(opts.warmup ?? '5s'),
    mode,
    rps: num(opts.rps, 5, '--rps'),
    users: Math.max(1, Math.round(num(opts.users, 25, '--users'))),
    maxConcurrent: Math.max(1, Math.round(num(opts.maxConcurrent, 40, '--max-concurrent'))),
    thinkTimeMs: num(opts.thinkTime, 250, '--think-time'),
    seed,
    runId: `s${seed}-${Date.now().toString(36)}`,
    chaos: opts.chaos ?? true,
    adminEmail: adminEmail.trim() || null,
    adminPassword: adminPassword.trim() || null,
    seedRooms: Math.max(0, Math.round(num(opts.seedRooms, 5, '--seed-rooms'))),
    daysAhead: Math.max(1, Math.round(num(opts.daysAhead, 14, '--days-ahead'))),
    reportIntervalMs: Math.max(1000, num(opts.reportInterval, 5, '--report-interval') * 1000),
    timeoutMs: num(opts.timeout, 10_000, '--timeout'),
    outDir: opts.out ?? 'reports',
    simPassword: opts.simPassword ?? env.SIM_PASSWORD ?? 'SimPass123!',
  };
};
