/** Cliente HTTP tipado contra la API de proyectoXP (fetch nativo de Node ≥ 20). */

import { ApiError, NetworkError } from './errors.js';
import { origen } from './origen.js';
import type { ApiErrorBody } from './types.js';

/** Unidad mínima de métrica: una petición HTTP observada. */
export interface RequestOutcome {
  method: string;
  /** Path normalizado (ids reemplazados por `:id`) para agrupar métricas. */
  endpoint: string;
  /** 0 = nunca llegó a responder (red/timeout). */
  status: number;
  durationMs: number;
}

export type RequestObserver = (outcome: RequestOutcome) => void;

interface RequestOptions {
  token?: string;
  /** Cabecera X-Idempotency-Key (HU-11, Actividad B). */
  idempotencyKey?: string;
}

interface FullRequestOptions extends RequestOptions {
  body?: unknown;
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly observer: RequestObserver,
    private readonly timeoutMs: number,
  ) {}

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, { ...options, body });
  }

  patch<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PATCH', path, { ...options, body });
  }

  delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  private async request<T>(
    method: string,
    path: string,
    options: FullRequestOptions,
  ): Promise<T> {
    const endpoint = normalizarEndpoint(method, path);
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
    if (options.idempotencyKey) headers['X-Idempotency-Key'] = options.idempotencyKey;
    const ip = origen.getStore();
    if (ip) headers['X-Forwarded-For'] = ip;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = performance.now();

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      this.observer({
        method,
        endpoint,
        status: res.status,
        durationMs: performance.now() - started,
      });

      if (!res.ok) {
        throw new ApiError(res.status, method, path, extraerMensaje(text));
      }

      try {
        return (text ? JSON.parse(text) : undefined) as T;
      } catch {
        // 2xx pero el body no es JSON: casi siempre significa que otra
        // aplicación ocupa el puerto (p. ej. un dev server de frontend).
        throw new NetworkError(
          method,
          path,
          `la respuesta no es JSON (content-type: ${res.headers.get('content-type') ?? 'desconocido'}, status ${res.status}). ` +
            `¿Hay otra aplicación escuchando en ${this.baseUrl}? El backend de proyectoXP responde JSON en /health.`,
        );
      }
    } catch (err) {
      if (err instanceof ApiError || err instanceof NetworkError) throw err;
      // No llegó respuesta: se observa como status 0 (error de red).
      this.observer({
        method,
        endpoint,
        status: 0,
        durationMs: performance.now() - started,
      });
      throw new NetworkError(
        method,
        path,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * `GET /api/reservations/42` → `GET /api/reservations/:id`, para que las
 * métricas agrupen por recurso y no por instancia.
 */
export const normalizarEndpoint = (method: string, path: string): string => {
  const normalizado = path
    .replace(/\/users\/\d+/g, '/users/:id')
    .replace(/\/rooms\/\d+/g, '/rooms/:id')
    .replace(/\/reservations\/\d+/g, '/reservations/:id');
  return `${method} ${normalizado}`;
};

/** El backend responde `{ error: "..." }`; si el body no es JSON se queda con un fragmento. */
const extraerMensaje = (text: string): string => {
  try {
    const body = JSON.parse(text) as Partial<ApiErrorBody>;
    if (typeof body.error === 'string') return body.error;
  } catch {
    // body no JSON (p. ej. HTML de un proxy): cae al fallback de abajo.
  }
  return text.slice(0, 120) || '(sin cuerpo)';
};
