/**
 * Modo servicio (`coworking-sim control`): el simulador queda escuchando y
 * corre escenarios a pedido. Es lo que usan los botones del monitor de
 * proyectoXP (la API reenvía /monitor/escenarios/* a este servidor).
 *
 *   GET  /estado                     escenario en curso, progreso y último resultado
 *   GET  /escenarios                 catálogo
 *   POST /escenarios/:nombre?tasa=N  arranca uno (409 si ya hay otro corriendo)
 *   POST /detener                    corta el escenario en curso
 *
 * Una sola corrida a la vez: dos escenarios simultáneos mezclarían sus
 * métricas y no se sabría qué presión generó cada uno.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { ApiClient } from './api/client.js';
import { buildConfig, type CliOptions, type Config } from './config.js';
import { buscarEscenario, ESCENARIOS, type Escenario } from './escenarios.js';
import { MetricsCollector, type Snapshot } from './metrics/collector.js';
import { Reporter } from './report/reporter.js';
import { Engine } from './sim/engine.js';
import { SimState } from './sim/state.js';

/** Lo que el panel muestra de una corrida (en curso o terminada). */
export interface Resumen {
  peticiones: number;
  peticionesPorSegundo: number;
  admitidas: number;
  rechazadas429: number;
  errores5xx: number;
  erroresDeRed: number;
}

export const resumir = (s: Snapshot): Resumen => ({
  peticiones: s.totalRequests,
  peticionesPorSegundo: Math.round(s.rpsReal * 10) / 10,
  admitidas: s.totalRequests - s.porEstado.red - s.porEstado.rateLimited429,
  rechazadas429: s.porEstado.rateLimited429,
  errores5xx: s.porEstado.server5xx,
  erroresDeRed: s.porEstado.red,
});

interface Corrida {
  escenario: Escenario;
  tasa?: number;
  cfg: Config;
  engine: Engine;
  metrics: MetricsCollector;
  iniciada: number;
  detenida: boolean;
}

interface Terminada {
  escenario: string;
  titulo: string;
  terminada: string;
  motivo: 'completo' | 'detenido' | 'error';
  error?: string;
  resumen: Resumen;
}

export class Controlador {
  private actual: Corrida | null = null;
  private ultima: Terminada | null = null;

  constructor(
    private readonly base: CliOptions,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  estado(): Record<string, unknown> {
    const c = this.actual;
    return {
      corriendo: c !== null,
      actual: c && {
        escenario: c.escenario.nombre,
        titulo: c.escenario.titulo,
        tasa: c.tasa ?? null,
        iniciada: new Date(c.iniciada).toISOString(),
        duracionMs: c.cfg.durationMs,
        ...c.engine.progreso,
        deteniendo: c.detenida,
        resumen: resumir(c.metrics.snapshot()),
      },
      ultima: this.ultima,
    };
  }

  /** Arranca en segundo plano; devuelve enseguida. */
  iniciar(nombre: string, tasa?: number): { ok: true } | { ok: false; status: number; error: string } {
    const escenario = buscarEscenario(nombre);
    if (!escenario) return { ok: false, status: 404, error: `No existe el escenario "${nombre}"` };
    if (this.actual) {
      return { ok: false, status: 409, error: `Ya está corriendo "${this.actual.escenario.titulo}": detenelo primero` };
    }
    if (tasa !== undefined && (!Number.isFinite(tasa) || tasa <= 0 || tasa > 1000)) {
      return { ok: false, status: 400, error: '"tasa" debe ser un número entre 1 y 1000' };
    }

    const cfg = buildConfig({ ...this.base, ...escenario.opciones(escenario.aceptaTasa ? tasa : undefined) }, this.env);
    const metrics = new MetricsCollector();
    const api = new ApiClient(cfg.baseUrl, (o) => metrics.registrar(o), cfg.timeoutMs);
    const engine = new Engine(cfg, api, metrics, new SimState());
    const corrida: Corrida = { escenario, tasa, cfg, engine, metrics, iniciada: Date.now(), detenida: false };
    this.actual = corrida;
    console.log(`▶ Escenario "${escenario.titulo}"${tasa ? ` a ${tasa} sesiones/s` : ''}`);
    void this.correr(corrida);
    return { ok: true };
  }

  async detener(): Promise<boolean> {
    const c = this.actual;
    if (!c) return false;
    c.detenida = true;
    await c.engine.detener();
    return true;
  }

  private async correr(c: Corrida): Promise<void> {
    const reporter = new Reporter(c.cfg, c.metrics);
    let motivo: Terminada['motivo'] = 'completo';
    let error: string | undefined;
    try {
      await c.engine.start();
      if (c.detenida) motivo = 'detenido';
    } catch (err) {
      motivo = 'error';
      error = err instanceof Error ? err.message : String(err);
      console.error(`✗ Escenario "${c.escenario.titulo}": ${error}`);
    }
    const s = c.metrics.snapshot();
    reporter.informeFinal(s, Date.now() - c.iniciada);
    this.ultima = {
      escenario: c.escenario.nombre,
      titulo: c.escenario.titulo,
      terminada: new Date().toISOString(),
      motivo,
      error,
      resumen: resumir(s),
    };
    this.actual = null;
  }
}

const responder = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

export const crearServidorDeControl = (controlador: Controlador) =>
  createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ruta = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && ruta === '/estado') return responder(res, 200, controlador.estado());
    if (req.method === 'GET' && ruta === '/escenarios') {
      return responder(
        res,
        200,
        ESCENARIOS.map(({ nombre, titulo, descripcion, aceptaTasa }) => ({
          nombre,
          titulo,
          descripcion,
          aceptaTasa: aceptaTasa ?? false,
        })),
      );
    }
    if (req.method === 'POST' && ruta === '/detener') {
      void controlador.detener().then((habia) => responder(res, 200, { detenido: habia }));
      return;
    }
    const match = /^\/escenarios\/([a-z-]+)$/.exec(ruta);
    if (req.method === 'POST' && match) {
      const tasaTexto = url.searchParams.get('tasa');
      const resultado = controlador.iniciar(match[1] ?? '', tasaTexto === null ? undefined : Number(tasaTexto));
      return resultado.ok
        ? responder(res, 202, controlador.estado())
        : responder(res, resultado.status, { error: resultado.error });
    }
    responder(res, 404, { error: 'No encontrado' });
  });
