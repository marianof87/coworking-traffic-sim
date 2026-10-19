/**
 * Generador de números pseudoaleatorios con semilla (mulberry32).
 *
 * Toda la simulación sale de acá: con la misma `--seed` se repite la misma
 * secuencia de decisiones, lo que hace reproducible un experimento de carga.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }

  /** Uniforme en [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Entero uniforme en [min, max] (ambos incluidos). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: colección vacía');
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('Rng.pick: índice fuera de rango');
    return item;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Distribución exponencial con la media dada: la clásica para "think time". */
  exponential(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }

  /** Identificador corto y único-ish para claves de idempotencia y emails. */
  uuid(): string {
    return (
      Math.floor(this.next() * 0xfffffff).toString(36) +
      Math.floor(this.next() * 0xfffffff).toString(36)
    );
  }
}
