# coworking-traffic-sim

Simulador de tráfico **realista** para la API de **proyectoXP** — la plataforma de reserva de espacios de coworking ([github.com/marianof87/proyectoXP](https://github.com/marianof87/proyectoXP)).

Es el "sistema interno de la empresa" que genera peticiones contra el backend: usuarios virtuales con nombre, email y saldo propios que navegan el catálogo, reservan salas, cancelan, recargan saldo, cierran sesión y ejercitan los caminos de error (401/403/404/409) que el backend define en sus HU-08 a HU-11. Cada petición queda medida (latencia por endpoint, códigos HTTP, KPIs de negocio) y el resultado se informa en consola y en JSON.

- **Lenguaje:** Node.js ≥ 20 + TypeScript (`strict`), fetch nativo
- **Sin dependencias pesadas:** solo `commander` y `dotenv`
- **Reproducible:** toda la aleatoriedad sale de un RNG con semilla (`--seed`)

---

## Puesta en marcha

```bash
npm install
cp .env.example .env       # opcional: BASE_URL, credenciales de ADMIN, etc.

# 1. Validar que el backend responde según el contrato (los 15 endpoints)
npm run smoke -- --base-url http://localhost:3000

# 2. Generar tráfico
npm run sim -- -d 60s -r 10 -u 25
```

El backend debe estar corriendo (`npm run dev` de proyectoXP con PostgreSQL, o el arnés en memoria de más abajo).

### El rol del ADMIN (recomendado)

El backend **no tiene endpoint para crear admins** (el registro siempre asigna rol `USER`), así que para que el simulador pueda crear salas y avanzar estados de reservas hay que dar de alta un admin directamente en la base:

```sql
INSERT INTO users (email, name, password, role, balance, "createdAt", "updatedAt")
VALUES ('admin@coworking.com', 'Admin', '<hash bcrypt>', 'ADMIN', 0, NOW(), NOW());
```

```bash
# el hash se genera con:
node -e "console.log(require('bcrypt').hashSync('AdminPass123!', 10))"
```

Y en `.env` (o por flags):

```
ADMIN_EMAIL=admin@coworking.com
ADMIN_PASSWORD=AdminPass123!
```

Sin admin el simulador funciona igual, pero no creará salas (si el catálogo está vacío, los recorridos de reserva terminan sin reservar) ni avanzará estados.

---

## Qué genera

### Recorridos (journeys)

Cada sesión ejecuta un recorrido completo elegido por pesos. Respeta las reglas del backend: verifica disponibilidad antes de reservar, recarga si le falta saldo, solo cancela reservas propias futuras, y reintenta con otra franja si otro usuario virtual se le adelantó (409).

| Recorrido | Peso | Qué hace |
| --- | --- | --- |
| `reserva-simple` | 26 | login → catálogo → check-availability → reserva (30% con `X-Idempotency-Key`) → historial |
| `consulta-publica` | 20 | login → lista salas → detalle de sala → consulta de disponibilidad → perfil |
| `reserva-y-cancela` | 14 | reserva y la cancela después (ejercita el reembolso de HU-06) |
| `gestion-cuenta` | 12 | perfil → recarga de saldo → historial → 35% logout + login nuevo (revocación de token, HU-11) |
| `reintento-idempotente` | 7 | reserva con clave, repite la MISMA petición y verifica que devuelve la MISMA reserva sin cobrar dos veces |
| `alta-usuario` | 6 | registro de una cuenta nueva con email único (HU-01) + login + recarga inicial |
| `admin-personal` | 5 | (solo con ADMIN) altas de sala (HU-05) y avance de estados `CONFIRMED → IN_PROGRESS → COMPLETED` (HU-11) |
| `ruido-legitimo` | 5* | errores 4xx que un usuario provoca sin querer: 404, 403 (crear sala sin rol ADMIN), 400 (recarga negativa), 401 (sin token), 409 (reservar un tramo ya reservado) |
| `login-invalido` | 3* | login con contraseña equivocada → 401 genérico (HU-08) |

\* Los marcados con `*` son "chaos": se desactivan con `--no-chaos`. Que respondan 4xx **es** el comportamiento correcto del backend; se cuentan aparte en el informe.

### Métricas e informe

- **Por endpoint:** cantidad, latencia media/p50/p90/p95/p99/máx y distribución de códigos HTTP (agrupando ids: `/api/reservations/:id`).
- **Por recorrido:** éxitos, fallos y motivos de fallo más frecuentes.
- **KPIs de negocio:** reservas creadas, canceladas y completadas; montos reservados y reembolsados; logins e intentos fallidos simulados; recargas.
- **En vivo:** línea de estado cada `--report-interval` segundos.
- **JSON completo** en `reports/sim-<runId>.json` para graficar o comparar corridas.

```
Peticiones: 652 (31.8 peticiones/s reales) · 2xx 92.9% · 4xx 7.1% · 5xx 0.0% · red 0

Latencia por endpoint (ms)
  Endpoint                                Nº   media  p50  p95  p99  máx  estados
  POST /api/rooms/:id/check-availability  170  2.1    2    3    6    6    200×170
  POST /api/reservations                  85   2.1    2    3    5    5    201×79 409×6
  POST /api/users/login                   23   50.3   50   53   59   59   200×15 401×8
  ...

Recorridos (journeys)
  Recorrido              Nº  ok  fallo  % ok
  reserva-simple         41  41  0      100%
  ...

KPIs de negocio
  Reservas creadas: 69 (monto reservado $4.420)
  Reservas canceladas: 28 (reembolsado $1.770)
  Reservas completadas por el admin: 6
```

---

## Modelos de carga

- **Abierto (`--mode open`, por defecto):** las sesiones llegan como un proceso de Poisson a la tasa `--rps`. Modela "usuarios llegando a la web" con la tasa que se quiera estresar; `--max-concurrent` techo de peticiones en vuelo.
- **Cerrado (`--mode closed`):** `--users` usuarios en bucle continuo con think time exponencial (media `--think-time`). Modela una cantidad fija de usuarios concurrentes.

Ambos modelos comparten un pool de usuarios virtuales **exclusivo**: un usuario nunca está en dos sesiones a la vez; si se agota, las sesiones esperan su turno.

## Opciones CLI

| Flag | Env | Default | Descripción |
| --- | --- | --- | --- |
| `-b, --base-url <url>` | `BASE_URL` | `http://localhost:3000` | URL base del backend |
| `-d, --duration <t>` | — | `60s` | Duración de la ventana medida (`90`, `90s`, `2m`, `1h`) |
| `-u, --users <n>` | — | `25` | Usuarios virtuales del pool |
| `-r, --rps <n>` | — | `5` | Sesiones/s objetivo (modo abierto); cada sesión genera varias peticiones |
| `-m, --mode <modo>` | — | `open` | `open` \| `closed` |
| `--think-time <ms>` | — | `250` | Pausa media entre pasos de un recorrido |
| `--max-concurrent <n>` | — | `40` | Peticiones en vuelo máximo |
| `--warmup <s>` | — | `5` | Calentamiento (tráfico que no se mide) |
| `--seed <n>` | — | `42` | Semilla del RNG: misma seed = misma corrida |
| `--no-chaos` | — | off | Desactiva los recorridos de errores esperados |
| `--admin-email <email>` | `ADMIN_EMAIL` | — | Email del ADMIN |
| `--admin-password <pass>` | `ADMIN_PASSWORD` | — | Password del ADMIN |
| `--seed-rooms <n>` | — | `5` | Crea salas con el admin si el catálogo tiene menos (`0` = no crear) |
| `--days-ahead <n>` | — | `14` | Días hacia adelante en los que se reserva: junto con las salas define el espacio de franjas libres |
| `--report-interval <s>` | — | `5` | Cadencia del estado en vivo |
| `--timeout <ms>` | — | `10000` | Timeout por petición |
| `--out <dir>` | — | `reports` | Directorio de informes JSON |
| `--sim-password <pass>` | `SIM_PASSWORD` | `SimPass123!` | Contraseña de los usuarios virtuales (≥ 8 caracteres) |

`Ctrl+C` corta el scheduleo, deja terminar las peticiones en vuelo (máx. 15 s) e imprime el informe igual.

### Ejemplos

```bash
# Estrés sostenido: 25 sesiones/s (≈ varias peticiones por sesión) durante
# 5 minutos contra el backend, con admin para sembrar salas y avanzar estados
ADMIN_EMAIL=admin@coworking.com ADMIN_PASSWORD=AdminPass123! \
  npm run sim -- -b http://localhost:3300 -d 5m -r 25 -u 80 --max-concurrent 120

# Pico corto sin chaos (solo flujos felices)
npm run sim -- -d 2m -r 100 --no-chaos

# 20 usuarios concurrentes durante 3 minutos (modelo cerrado), semilla 7
npm run sim -- -m closed -u 20 -d 3m --seed 7
```

---

## Estructura

```
src/
  index.ts              # CLI (commander): run (por defecto) y smoke
  config.ts             # flags + env → Config validado
  smoke.ts              # validación de los 15 endpoints de punta a punta
  api/
    client.ts           # cliente HTTP tipado (fetch, timeout, observer de métricas)
    types.ts            # DTOs espejo de src/models del backend
    errors.ts           # ApiError / NetworkError + esperarEstado()
  sim/
    engine.ts           # fases (salud, admin, siembra, pool, calentamiento, medición)
    journeys.ts         # los 9 recorridos y su selección ponderada
    user.ts             # VirtualUser: sesión, saldo, historial, logout
    pool.ts             # pool exclusivo de usuarios con cola de espera
    state.ts            # catálogo de salas + libro de reservas compartido
    slots.ts            # generación de franjas horarias realistas
    personas.ts         # nombres/emails únicos por corrida
    rng.ts              # RNG con semilla (mulberry32)
  metrics/
    collector.ts        # latencias, códigos, journeys, KPIs
  report/
    reporter.ts         # ticker en vivo, informe final y JSON
```

## Probar sin PostgreSQL (arnés en memoria)

El backend de proyectoXP expone `createApp(createInMemoryServices())` (lo mismo que usan sus pruebas BDD). Con eso se puede levantar la API completa sin base de datos:

```ts
// dev-server.ts dentro de una copia de proyectoXP (con npm install + npx prisma generate)
import { createApp } from './src/app';
import { createInMemoryServices } from './src/container';

const { services } = createInMemoryServices();
createApp(services).listen(3100);
```

```bash
npx ts-node dev-server.ts
npm run smoke -- --base-url http://localhost:3100
npm run sim -- --base-url http://localhost:3100 -d 30s -r 8
```

El estado vive en memoria: al reiniciar el proceso vuelve a estar vacío (y hay que volver a crear el admin, si se usa).

---

## Decisiones de diseño

- **El simulador no toca el backend:** es un cliente externo por HTTP puro; no importa ningún módulo de proyectoXP.
- **Realismo con estado:** los usuarios virtuales conocen su saldo y sus reservas, evitan solaparse entre ellos y reintentan como lo haría una persona; los errores 4xx esperados se generan a propósito y se reportan como tales, separados de los 5xx (que siempre son un problema).
- **Reproducibilidad:** con la misma `--seed` se repite la misma secuencia de decisiones, para poder comparar corridas antes/después de un cambio en el backend.
- **KISS/YAGNI:** sin agentes de Prometheus ni dashboards; informe de consola + JSON. Si un día se quiere Grafana, el JSON ya tiene la serie completa.
