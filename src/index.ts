#!/usr/bin/env node
/** CLI del simulador de tráfico: `run` (por defecto) y `smoke`. */

import 'dotenv/config';

import { Command } from 'commander';

import { ApiClient } from './api/client.js';
import { buildConfig, type CliOptions } from './config.js';
import { MetricsCollector } from './metrics/collector.js';
import { Reporter } from './report/reporter.js';
import { Engine } from './sim/engine.js';
import { SimState } from './sim/state.js';
import { runSmoke } from './smoke.js';

const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const agregarOpciones = (cmd: Command): Command =>
  cmd
    .option('-b, --base-url <url>', 'URL base del backend (env BASE_URL)', undefined)
    .option('-d, --duration <tiempo>', 'duración de la ventana medida: 90, 90s, 2m, 1h', '60s')
    .option('-u, --users <n>', 'usuarios virtuales del pool', '25')
    .option('-r, --rps <n>', 'tasa objetivo de sesiones en modo abierto', '5')
    .option('-m, --mode <modo>', 'modelo de carga: open | closed', 'open')
    .option('--think-time <ms>', 'think time medio entre pasos (ms)', '250')
    .option('--max-concurrent <n>', 'peticiones en vuelo máximo', '40')
    .option('--warmup <s>', 'segundos de calentamiento (no se miden)', '5')
    .option('--seed <n>', 'semilla del RNG (reproducibilidad)', '42')
    .option('--no-chaos', 'desactiva los recorridos de errores esperados (4xx a propósito)')
    .option('--admin-email <email>', 'email de un ADMIN (env ADMIN_EMAIL)')
    .option('--admin-password <pass>', 'password del ADMIN (env ADMIN_PASSWORD)')
    .option('--seed-rooms <n>', 'crear salas si el catálogo tiene menos (0 = no crear)', '5')
    .option('--days-ahead <n>', 'días hacia adelante en los que se reserva (espacio de slots)', '14')
    .option('--report-interval <s>', 'cada cuánto imprime estado en vivo', '5')
    .option('--timeout <ms>', 'timeout por petición', '10000')
    .option('--out <dir>', 'directorio de los informes JSON', 'reports')
    .option('--sim-password <pass>', 'contraseña de los usuarios virtuales (env SIM_PASSWORD)')
    .option('--ips-virtuales', 'una IP por usuario virtual vía X-Forwarded-For (la API necesita TRUST_PROXY=true)')
    .option('--escalones <tasas>', 'tasas en escalones durante la medición, p. ej. 2,5,10,20,40 (modo abierto)')
    .option('--mezcla <nombre>', 'realista (por defecto) | autenticacion (sobre todo logins: carga de CPU)');

const imprimirPlan = (cfg: ReturnType<typeof buildConfig>): void => {
  console.log('');
  console.log('Plan de simulación');
  console.log(`  Objetivo      ${cfg.baseUrl}`);
  console.log(
    `  Modelo        ${cfg.mode === 'open'
      ? `abierto — ${cfg.escalones ? `escalones ${cfg.escalones.join(' → ')}` : cfg.rps} sesiones/s (Poisson); cada sesión genera varias peticiones`
      : `cerrado — ${cfg.users} usuarios en bucle con think time`}`,
  );
  console.log(`  Duración      ${(cfg.durationMs / 1000).toFixed(0)}s medida + ${(cfg.warmupMs / 1000).toFixed(0)}s de calentamiento`);
  console.log(`  Usuarios      ${cfg.users} virtuales · think time medio ${cfg.thinkTimeMs} ms`);
  console.log(`  Admin         ${cfg.adminEmail ?? '(sin admin: sin altas de sala ni avance de estados)'}`);
  console.log(`  Mezcla        ${cfg.mezcla} · IPs ${cfg.ipsVirtuales ? 'una por usuario virtual (X-Forwarded-For)' : 'una sola para todo el simulador'}`);
  console.log(`  Salas         seed ${cfg.seedRooms === 0 ? 'off' : `hasta ${cfg.seedRooms}`} · horizonte ${cfg.daysAhead} días · chaos ${cfg.chaos ? 'on' : 'off'} · seed RNG ${cfg.seed}`);
  console.log('');
};

const ejecutarSimulacion = async (opts: CliOptions): Promise<void> => {
  const cfg = buildConfig(opts, process.env);
  const metrics = new MetricsCollector();
  const state = new SimState();
  const api = new ApiClient(cfg.baseUrl, (o) => metrics.registrar(o), cfg.timeoutMs);
  const reporter = new Reporter(cfg, metrics);
  const engine = new Engine(cfg, api, metrics, state);

  imprimirPlan(cfg);

  let interrupciones = 0;
  const alInterrumpir = async (): Promise<void> => {
    interrupciones += 1;
    if (interrupciones > 1) process.exit(130);
    console.log(`\n${YELLOW}Interrumpido (Ctrl+C): drenando peticiones en vuelo…${RESET}`);
    reporter.detenerTicker();
    await engine.detener();
    const s = metrics.snapshot();
    reporter.informeFinal(s, s.windowMs);
    reporter.escribirInformeJson(s);
    process.exit(130);
  };
  process.on('SIGINT', () => void alInterrumpir());

  reporter.iniciarTicker(() => engine.etapaActual);
  const t0 = Date.now();
  try {
    await engine.start();
  } finally {
    reporter.detenerTicker();
  }

  const s = metrics.snapshot();
  reporter.informeFinal(s, Date.now() - t0);
  reporter.escribirInformeJson(s);
};

const programa = new Command();

programa
  .name('coworking-sim')
  .description('Simulador de tráfico realista para la API de proyectoXP (coworking)')
  .version('1.0.0');

agregarOpciones(
  programa
    .command('run', { isDefault: true })
    .description('Genera tráfico continuo contra la API y emite el informe'),
  ).action(async (opts: CliOptions) => {
    await ejecutarSimulacion(opts);
  });

agregarOpciones(
  programa
    .command('smoke')
    .description('Valida los 15 endpoints de punta a punta (sin aplicar carga)'),
  ).action(async (opts: CliOptions) => {
    const cfg = buildConfig(opts, process.env);
    const ok = await runSmoke(cfg);
    process.exit(ok ? 0 : 1);
  });

programa.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
