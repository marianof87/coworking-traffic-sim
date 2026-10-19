/** Errores del cliente: respuesta HTTP del backend vs fallo de red. */

/** El backend respondió con un status fuera de 2xx. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    /** Mensaje del body `{ error }` del backend, o el texto crudo. */
    readonly serverMessage: string,
  ) {
    super(`${method} ${path} → ${status}: ${serverMessage}`);
    this.name = 'ApiError';
  }
}

/** No se pudo completar la petición (DNS, conexión rechazada, timeout…). */
export class NetworkError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    cause: string,
  ) {
    super(`${method} ${path} → error de red: ${cause}`);
    this.name = 'NetworkError';
  }
}

/**
 * Para los recorridos que ejercitan caminos de error a propósito (HU-08/09/10):
 * si el error es un ApiError con uno de los statuses esperados, se traga;
 * cualquier otra cosa (500, red, assert del propio recorrido) se propaga
 * y marca el recorrido como fallido.
 */
export const esperarEstado = (err: unknown, ...esperados: number[]): void => {
  if (err instanceof ApiError && esperados.includes(err.status)) {
    return;
  }
  throw err;
};
