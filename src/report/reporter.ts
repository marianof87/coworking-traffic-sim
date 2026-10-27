/** Salida en vivo + informe final en consola y JSON. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Config } from '../config.js';
import type { MetricsCollector, Snapshot } from '../metrics/collector.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

export class Reporter {
  private ticker: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly metrics: MetricsCollector,
  ) {}

  /** Línea de estado cada `--report-interval` segundos. `fase` etiqueta la línea. */
  iniciarTicker(fase: () => string): void {
    this.ticker = setInterval(() => {
      const s = this.metrics.snapshot();
      const e = s.porEstado;
      const total = Math.max(1, s.totalRequests);
      const pct = (n: number): string => `${((n / total) * 100).toFixed(1)}%`;
      const p95 = s.endpoints.length > 0
        ? Math.max(...s.endpoints.map((ep) => ep.p95))
        : 0;
      console.log(
        `${DIM}[${fase()}]${RESET} ${(s.windowMs / 1000).toFixed(0)}s · ` +
          `${s.totalRequests} peticiones · ${s.rpsReal.toFixed(1)} peticiones/s · ` +
          `p95 máx ${p95.toFixed(0)} ms · ` +
          `2xx ${pct(e.ok2xx)} ${DIM}4xx ${pct(e.client4xx)} (429 ${pct(e.rateLimited429)}) 5xx ${pct(e.server5xx)}${RESET}`,
      );
    }, this.cfg.reportIntervalMs);
    this.ticker.unref();
  }

  detenerTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  informeFinal(s: Snapshot, ejecutadoEnMs: number): void {
    const e = s.porEstado;
    const total = Math.max(1, s.totalRequests);
    const pct = (n: number): string => `${((n / total) * 100).toFixed(1)}%`;

    console.log('');
    console.log(`${BOLD}${'═'.repeat(72)}${RESET}`);
    console.log(`${BOLD} SIMULACIÓN FINALIZADA${RESET}  ${DIM}run ${this.cfg.runId}${RESET}`);
    console.log(
      ` Objetivo: ${this.cfg.baseUrl} · ventana medida ${(s.windowMs / 1000).toFixed(1)}s ` +
        `(+${(this.cfg.warmupMs / 1000).toFixed(0)}s de calentamiento) · total real ${(ejecutadoEnMs / 1000).toFixed(1)}s`,
    );
    console.log(
      ` Modo: ${this.cfg.mode === 'open' ? `abierto, ${this.cfg.rps} rps objetivo` : `cerrado, ${this.cfg.users} usuarios`} · ` +
        `usuarios virtuales: ${this.cfg.users} · chaos ${this.cfg.chaos ? 'activado' : 'desactivado'} · admin ${this.hayAdmin() ? 'sí' : 'no'}`,
    );
    console.log(`${'═'.repeat(72)}${RESET}`);

    console.log(
      `\n${BOLD}Peticiones:${RESET} ${s.totalRequests} (${s.rpsReal.toFixed(1)} peticiones/s reales) · ` +
        `2xx ${colorPct(e.ok2xx, total)} · 4xx ${pct(e.client4xx)} · 5xx ${colorPct(e.server5xx, total, true)} · ` +
        `red ${e.red}`,
    );
    console.log(
      `${BOLD}Admisión (rate limit):${RESET} admitidas ${s.totalRequests - e.red - e.rateLimited429} · ` +
        `rechazadas con 429 ${colorPct(e.rateLimited429, total, true)} (${e.rateLimited429})`,
    );
    const limitados = s.endpoints.filter((ep) => ep.rateLimited429 > 0);
    for (const ep of limitados) {
      console.log(`  ${DIM}·${RESET} ${ep.endpoint}: ${ep.rateLimited429} de ${ep.count} rechazadas`);
    }

    // Tabla por endpoint
    if (s.endpoints.length > 0) {
      const filas = s.endpoints.map((ep) => {
        const estados = Object.entries(ep.statuses)
          .sort((a, b) => b[1] - a[1])
          .map(([status, n]) => `${status}×${n}`)
          .join(' ');
        return [
          ep.endpoint,
          String(ep.count),
          ep.mean.toFixed(1),
          ep.p50.toFixed(0),
          ep.p95.toFixed(0),
          ep.p99.toFixed(0),
          ep.max.toFixed(0),
          estados,
        ];
      });
      console.log(`\n${BOLD}Latencia por endpoint (ms)${RESET}`);
      printTable(
        ['Endpoint', 'Nº', 'media', 'p50', 'p95', 'p99', 'máx', 'estados'],
        filas,
      );
    }

    // Recorridos
    if (s.journeys.length > 0) {
      const filas = s.journeys.map((j) => [
        j.name,
        String(j.total),
        String(j.ok),
        String(j.failed),
        `${((j.ok / Math.max(1, j.total)) * 100).toFixed(0)}%`,
      ]);
      console.log(`\n${BOLD}Recorridos (journeys)${RESET}`);
      printTable(['Recorrido', 'Nº', 'ok', 'fallo', '% ok'], filas);

      const conFallos = s.journeys.filter((j) => j.failed > 0);
      if (conFallos.length > 0) {
        console.log(`\n${BOLD}Motivos de fallo${RESET}`);
        for (const j of conFallos) {
          for (const [motivo, n] of Object.entries(j.motivos).slice(0, 5)) {
            console.log(`  ${DIM}·${RESET} ${j.name} → ${motivo} ${DIM}(${n}×)${RESET}`);
          }
        }
      }
    }

    // KPIs de negocio
    const k = s.kpi;
    console.log(`\n${BOLD}KPIs de negocio${RESET}`);
    console.log(
      `  Reservas creadas: ${k.reservasCreadas} (monto reservado ${fmtMoneda(k.montoReservado)})`,
    );
    console.log(
      `  Reservas canceladas: ${k.reservasCanceladas} (reembolsado ${fmtMoneda(k.montoReembolsado)})`,
    );
    console.log(`  Reservas completadas por el admin: ${k.reservasCompletadas}`);
    console.log(
      `  Logins: ${k.logins} · intentos fallidos simulados: ${k.loginsFallidos} · recargas: ${k.recargas}`,
    );
    console.log(`  Errores 4xx provocados a propósito (chaos): ${k.erroresSimulados}`);
    console.log('');
  }

  escribirInformeJson(s: Snapshot): string {
    mkdirSync(this.cfg.outDir, { recursive: true });
    const archivo = join(this.cfg.outDir, `sim-${this.cfg.runId}.json`);
    const documento = {
      generadoEn: new Date().toISOString(),
      config: {
        baseUrl: this.cfg.baseUrl,
        mode: this.cfg.mode,
        rps: this.cfg.rps,
        users: this.cfg.users,
        durationMs: this.cfg.durationMs,
        warmupMs: this.cfg.warmupMs,
        thinkTimeMs: this.cfg.thinkTimeMs,
        seed: this.cfg.seed,
        chaos: this.cfg.chaos,
        admin: this.hayAdmin(),
      },
      resultado: s,
    };
    writeFileSync(archivo, JSON.stringify(documento, null, 2), 'utf8');
    console.log(`${DIM}Informe JSON: ${archivo}${RESET}`);
    return archivo;
  }

  private hayAdmin(): boolean {
    return this.cfg.adminEmail !== null;
  }
}

const colorPct = (n: number, total: number, rojoSiHay = false): string => {
  const texto = `${((n / total) * 100).toFixed(1)}%`;
  if (n === 0) return `${GREEN}${texto}${RESET}`;
  if (rojoSiHay) return `${RED}${texto}${RESET}`;
  return texto;
};

const fmtMoneda = (monto: number): string => `$${monto.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;

const printTable = (cabeceros: string[], filas: string[][]): void => {
  const anchos = cabeceros.map((c, i) =>
    Math.max(c.length, ...filas.map((f) => (f[i] ?? '').length)),
  );
  const linea = (celdas: string[]): string =>
    celdas.map((c, i) => c.padEnd(anchos[i] ?? 0)).join('  ').trimEnd();
  console.log(`  ${DIM}${linea(cabeceros)}${RESET}`);
  for (const fila of filas) {
    console.log(`  ${linea(fila)}`);
  }
};
