import { defineConfig } from 'vitest/config';

/**
 * Dos proyectos de prueba (ver docs/TESTING.md):
 *
 * - `unit`: unidades y componentes del simulador, sin backend. Rápidas,
 *   deterministas, corren siempre (`npm test`).
 * - `e2e`: el simulador contra la API real de proyectoXP (`npm run test:e2e`).
 *   Los archivos van en serie porque el rate limit del backend es por IP: dos
 *   archivos en paralelo se robarían el cupo y las cuentas no cerrarían.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/e2e/**'],
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['src/e2e/**/*.e2e.test.ts'],
          fileParallelism: false,
          // Puede hacer falta esperar a que venza la ventana del rate limit (60 s).
          testTimeout: 150_000,
          hookTimeout: 150_000,
        },
      },
    ],
  },
});
