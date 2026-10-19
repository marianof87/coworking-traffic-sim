/** Pool de usuarios virtuales: adquisición exclusiva con cola de espera. */

import type { VirtualUser } from './user.js';

/**
 * En el modelo cerrado cada "hilo" de carga tiene su usuario; en el abierto
 * las sesiones llegan a una tasa fija y toman prestado un usuario del pool.
 * Un usuario no debe estar en dos sesiones a la vez: si todos están ocupados,
 * la sesión espera su turno (autorregulación natural de la concurrencia).
 */
export class UserPool {
  private readonly libres: VirtualUser[];
  private readonly esperando: Array<(user: VirtualUser) => void> = [];

  constructor(users: VirtualUser[]) {
    this.libres = [...users];
  }

  get tamanio(): number {
    return this.libres.length + this.esperando.length;
  }

  async acquire(): Promise<VirtualUser> {
    const user = this.libres.pop();
    if (user) return user;
    return new Promise<VirtualUser>((resolve) => {
      this.esperando.push(resolve);
    });
  }

  release(user: VirtualUser): void {
    const siguiente = this.esperando.shift();
    if (siguiente) {
      siguiente(user);
    } else {
      this.libres.push(user);
    }
  }

  /** Devuelve todo el pool (útil al terminar para no dejar promesas colgando). */
  liberarTodos(): void {
    while (this.esperando.length > 0 && this.libres.length > 0) {
      const esperando = this.esperando.shift();
      const user = this.libres.pop();
      if (esperando && user) esperando(user);
    }
  }
}
