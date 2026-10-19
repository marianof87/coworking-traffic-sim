/** Recolección de métricas: latencias por endpoint, outcome de journeys y KPIs. */

import type { RequestOutcome } from '../api/client.js';

/** Contadores de negocio: qué produjo realmente la simulación. */
export interface Kpi {
  reservasCreadas: number;
  reservasCanceladas: number;
  reservasCompletadas: number;
  montoReservado: number;
  montoReembolsado: number;
  logins: number;
  loginsFallidos: number;
  recargas: number;
  erroresSimulados: number;
}

export interface EndpointSnapshot {
  endpoint: string;
  count: number;
  statuses: Record<number, number>;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

export interface JourneySnapshot {
  name: string;
  total: number;
  ok: number;
  failed: number;
  /** Motivos de fallo más frecuentes (`motivo` → cantidad). */
  motivos: Record<string, number>;
}

export interface Snapshot {
  /** Ventana medida (tras el calentamiento), en milisegundos. */
  windowMs: number;
  totalRequests: number;
  rpsReal: number;
  porEstado: {
    ok2xx: number;
    client4xx: number;
    server5xx: number;
    red: number;
  };
  endpoints: EndpointSnapshot[];
  journeys: JourneySnapshot[];
  kpi: Kpi;
}

interface EndpointData {
  count: number;
  statuses: Map<number, number>;
  durations: number[];
}

interface JourneyData {
  total: number;
  ok: number;
  failed: number;
  motivos: Map<string, number>;
}

const kpiInicial = (): Kpi => ({
  reservasCreadas: 0,
  reservasCanceladas: 0,
  reservasCompletadas: 0,
  montoReservado: 0,
  montoReembolsado: 0,
  logins: 0,
  loginsFallidos: 0,
  recargas: 0,
  erroresSimulados: 0,
});

export class MetricsCollector {
  private readonly endpoints = new Map<string, EndpointData>();
  private readonly journeys = new Map<string, JourneyData>();
  private datos: Kpi = kpiInicial();
  private desde = Date.now();

  /** Reinicia todo: se llama al terminar el calentamiento para que solo cuente la ventana medida. */
  reset(): void {
    this.endpoints.clear();
    this.journeys.clear();
    this.datos = kpiInicial();
    this.desde = Date.now();
  }

  get kpi(): Kpi {
    return this.datos;
  }

  registrar(outcome: RequestOutcome): void {
    let data = this.endpoints.get(outcome.endpoint);
    if (!data) {
      data = { count: 0, statuses: new Map(), durations: [] };
      this.endpoints.set(outcome.endpoint, data);
    }
    data.count += 1;
    data.statuses.set(outcome.status, (data.statuses.get(outcome.status) ?? 0) + 1);
    data.durations.push(outcome.durationMs);
  }

  registrarJourney(name: string, ok: boolean, motivo?: string): void {
    let data = this.journeys.get(name);
    if (!data) {
      data = { total: 0, ok: 0, failed: 0, motivos: new Map() };
      this.journeys.set(name, data);
    }
    data.total += 1;
    if (ok) {
      data.ok += 1;
    } else {
      data.failed += 1;
      const clave = motivo ?? 'desconocido';
      data.motivos.set(clave, (data.motivos.get(clave) ?? 0) + 1);
    }
  }

  snapshot(): Snapshot {
    const windowMs = Math.max(1, Date.now() - this.desde);
    const endpoints: EndpointSnapshot[] = [];
    let totalRequests = 0;
    let ok2xx = 0;
    let client4xx = 0;
    let server5xx = 0;
    let red = 0;

    for (const [endpoint, data] of this.endpoints) {
      totalRequests += data.count;
      const estados: Record<number, number> = {};
      for (const [status, cantidad] of data.statuses) {
        estados[status] = cantidad;
        if (status === 0) red += cantidad;
        else if (status >= 500) server5xx += cantidad;
        else if (status >= 400) client4xx += cantidad;
        else ok2xx += cantidad;
      }
      const ordenados = [...data.durations].sort((a, b) => a - b);
      endpoints.push({
        endpoint,
        count: data.count,
        statuses: estados,
        mean: ordenados.reduce((acc, d) => acc + d, 0) / (ordenados.length || 1),
        p50: percentil(ordenados, 50),
        p90: percentil(ordenados, 90),
        p95: percentil(ordenados, 95),
        p99: percentil(ordenados, 99),
        max: ordenados[ordenados.length - 1] ?? 0,
      });
    }
    endpoints.sort((a, b) => b.count - a.count);

    const journeys: JourneySnapshot[] = [...this.journeys.entries()]
      .map(([name, data]) => ({
        name,
        total: data.total,
        ok: data.ok,
        failed: data.failed,
        motivos: Object.fromEntries(
          [...data.motivos.entries()].sort((a, b) => b[1] - a[1]),
        ),
      }))
      .sort((a, b) => b.total - a.total);

    return {
      windowMs,
      totalRequests,
      rpsReal: totalRequests / (windowMs / 1000),
      porEstado: { ok2xx, client4xx, server5xx, red },
      endpoints,
      journeys,
      kpi: { ...this.datos },
    };
  }
}

/** Percentil sobre una lista YA ordenada (método del rango superior). */
export const percentil = (ordenados: readonly number[], p: number): number => {
  if (ordenados.length === 0) return 0;
  const indice = Math.max(0, Math.ceil((p / 100) * ordenados.length) - 1);
  return ordenados[indice] ?? 0;
};
