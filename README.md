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

### Modo servicio (botones del monitor)

`npm run dev -- control` (o la imagen de contenedor, que arranca así por defecto) deja al simulador escuchando en el puerto 4000 (`CONTROL_PORT`). Corre un escenario por vez a pedido:

| Método y ruta | Qué hace |
| --- | --- |
| `GET /escenarios` | Catálogo: `baja`, `creciente`, `saturacion`, `rate-limit` |
| `POST /escenarios/:nombre?tasa=N` | Arranca uno (409 si ya hay otro corriendo) |
| `GET /estado` | Escenario en curso, etapa, progreso, admitidas/rechazadas y el resultado de la última corrida |
| `POST /detener` | Corta el escenario en curso |

El `compose.yaml` de proyectoXP lo levanta como servicio `sim`; el monitor de la API (`/monitor/`) muestra los botones y reenvía las órdenes acá.

## Levantar el frontend / Visualizador de reportes

Este proyecto **no tiene una interfaz web integrada** para lanzar el simulador. Sin embargo, podés levantar un **servidor estático** para visualizar los archivos `.json` que se generan en la carpeta `reports/`.

> **Importante:** Primero tenés que correr el simulador apuntando al backend correcto. Si el backend está en `http://localhost:3300`, usá `-b http://localhost:3300`. Si el puerto `8080` está ocupado, `npx serve` elegirá otro automáticamente (por ejemplo, `35129`).

```bash
# Desde la raíz de este repositorio
cd /home/commitar/sinaptek/proyectoXP-traffic-sim

# Levantar servidor estático para ver los reportes
npx serve reports -l 8080
```

Abrí en tu navegador:

```text
http://localhost:8080
```

Ahí vas a ver el listado de reportes generados (`sim-<runId>.json`). Seleccionando cualquiera de ellos podés ver el contenido completo. 

**Notas:**
- Este es **únicamente un visor de reportes**. No controla el simulador ni llama a la API.
- Los comandos para correr el simulador siguen siendo los de consola (`npm run smoke` / `npm run sim`).

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

Ambos modelos comparten un pool de usuarios virtuales **exclusivo**: un usuario nunca está en dos sesiones a la vez; si se agota, las sesiones esperan su turno. El pool **rota** los usuarios (sale primero el que lleva más tiempo libre), así la carga se reparte entre todos y nadie choca solo contra el rate limit.

En contenedor lo levanta el `compose.yaml` de proyectoXP (servicio `sim`); sus escenarios preparados están en `proyectoXP/escenarios.sh`.

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
| `--ips-virtuales` | `SIM_IPS_VIRTUALES` | off | Una IP por usuario virtual en `X-Forwarded-For`: el rate limit por IP los cuenta por separado (la API necesita `TRUST_PROXY=true`) |
| `--escalones <tasas>` | `SIM_ESCALONES` | — | Tasas en escalones iguales durante la medición, p. ej. `2,5,10,20,40` (modo abierto) |
| `--mezcla <nombre>` | `SIM_MEZCLA` | `realista` | `autenticacion`: casi todo logins (bcrypt), para presionar los worker threads de la API |

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

---------------------------------------------

Cómo funciona coworking-traffic-sim
La idea central
Es un programa separado del backend que se conecta por HTTP a la API de proyectoXP y la consume como lo haría la gente real de una empresa: usuarios que miran salas, reservan, cancelan, recargan saldo, algún admin da de alta salas y avanza estados — solo que a escala, en bucle y sin cansarse. No toca la base de datos ni importa código del backend: solo habla por la API, igual que haría cualquier cliente.
┌─────────────────────────────┐   HTTP (fetch)   ┌──────────────────────────┐
│  coworking-traffic-sim      │ ───────────────► │  proyectoXP (Express)    │
│  Node + TS, proceso propio  │ ◄─────────────── │  /health  /api/*         │
└─────────────────────────────┘   JSON           └──────────────────────────┘
Arquitectura (qué hace cada archivo)
Archivo	Rol
src/index.ts	CLI (commander): arma la config, imprime el "Plan de simulación", arranca el motor, maneja Ctrl+C
src/config.ts	Valida flags + variables de entorno (BASE_URL, ADMIN_EMAIL…) en un objeto Config inmutable
src/sim/engine.ts	El motor: fases, scheduleo de tráfico, ciclo de vida
src/sim/journeys.ts	Los 9 recorridos de usuario y su selección por pesos
src/sim/user.ts	VirtualUser: alta, login, token, saldo — gestiona su propia sesión
src/sim/pool.ts	Pool de usuarios: acquire() / release() para que dos sesiones nunca compartan usuario
src/sim/state.ts	Estado compartido: catálogo de salas + "libro" de reservas (tope 300)
src/sim/slots.ts	Elige franjas futuras realistas (1 a --days-ahead días, 8–18 h, 1–4 h)
src/sim/personas.ts	Genera personas deterministas (smoke-<run>-1@example.com…)
src/sim/rng.ts	RNG con semilla (mulberry32): misma --seed = misma corrida
src/api/client.ts	Cliente fetch tipado: headers, token, idempotencia, timeout, y un observador que reporta cada respuesta a las métricas
src/metrics/collector.ts	Acumula latencias por endpoint, estados, journeys, KPIs de negocio
src/report/reporter.ts	Ticker en vivo + informe final por consola + JSON en reports/
src/smoke.ts	Segundo comando: valida el contrato de los 15 endpoints (20 pasos)
Ciclo de vida de una corrida
npm run sim ejecuta el motor en fases secuenciales:
1. Salud          GET /health ×3 intentos → si falla, aborta con mensaje claro
2. Admin          login con ADMIN_EMAIL/ADMIN_PASSWORD (opcional)
3. Siembra salas  admin crea salas hasta --seed-rooms si el catálogo está corto
4. Pool           registra --users usuarios virtuales (login + recarga inicial 200-800)
5. Calentamiento  tráfico real pero NO medido (--warmup, default 5s)
6. Medición       ventana medida (--duration) → las métricas arrancan acá
7. Informe        consola + reports/sim-<run>.json
Durante los pasos 5–6 corre el ciclo de tráfico:
- Modelo abierto (--mode open, default): las sesiones llegan como un proceso de Poisson — intervalos exponenciales con media 1000/rps ms — cada una toma un usuario del pool, ejecuta un recorrido completo y lo devuelve. Techo de --max-concurrent peticiones en vuelo.
- Modelo cerrado (--mode closed): --users "hilos" que, cada vez que terminan un recorrido, esperan un think time (pausa exponencial, media --think-time) y repiten — modela "N personas usando la app a la vez".
Al final (o con Ctrl+C): se corta el scheduleo, se drenan las peticiones en vuelo (máx. 15 s) y se imprime el informe igual. Eso es el apagado ordenado.
Los 9 recorridos: de dónde sale la "mezcla real"
Cada sesión elige un recorrido al azar por pesos (seleccionarJourney):
Recorrido	Peso	Qué hace
reserva-simple	26	login → catálogo → check-availability → reserva (30% con X-Idempotency-Key) → historial
consulta-publica	20	solo lectura: salas, detalle, disponibilidad
reserva-y-cancela	14	reserva y después cancela (ejercita el reembolso)
gestion-cuenta	12	perfil, recarga, logout
reintento-idempotente	7	fuerza el escenario de carrera: si el slot recién se tomó (409), reintenta con otra franja reusando la misma clave
alta-usuario	6	registra una persona nueva
admin-personal	5	(solo con admin) crea sala y avanza CONFIRMED → IN_PROGRESS → COMPLETED
login-invalido chaos	3	contraseña incorrecta → 401 esperado
ruido-legitimo chaos	5	errores que un usuario provoca sin querer: 404, 403, 400, 401
Detalles de realismo:
- think() entre pasos: nadie hace click a velocidad de máquina; hay pausas exponenciales.
- asegurarSaldo: si le falta saldo para pagar (horas × tarifa), recarga antes de reservar — como haría cualquiera.
- elegirSalaYSlot: consulta check-availability de verdad; si el tramo está tomado, prueba otra sala/franja (hasta 3 veces) y si no, se va sin reservar — no inventa errores.
- Los chaos solo donde el error ES el resultado esperado; --no-chaos los apaga. Por eso el 4xx "sucio" del informe es esperado y el objetivo real es 0×5xx.
- Sin admin, los recorridos adminOnly se omiten (avisa en el plan).
Estado compartido: por qué se comporta como un sistema, no como un fuzzer
SimState es memoria común entre corridas:
- Catálogo de salas refrescado cada 30 s desde la API (si otro proceso creó salas, se enteran).
- Libro de reservas (tope 300): los recorridos evitan reservar un slot que otra corrida ya tomó — ahí nacen los 409 reales de carrera, que el reintento-idempotente reintenta con la misma clave de idempotencia (el backend devuelve la reserva original: eso valida HU-11).
- Pool de usuarios: cada usuario existe de verdad (fue registrado en la BD del backend), tiene token JWT propio, y dos sesiones simultáneas nunca lo comparten.
Determinismo
Todo el azar (llegadas, pesos, franjas, montos, think time) sale de Rng(42). Misma semilla + misma duración = misma corrida, lo que permite comparar antes/después de un cambio en el backend (p. ej. antes y después de optimizar una query).
Métricas e informes
El ApiClient tiene un observador que cada respuesta (incluso las que fallan) la reporta al MetricsCollector con método, endpoint normalizado, status y latencia. De ahí sale:
- Por endpoint: count, media, p50/p95/p99, máx y histograma de estados (200×4684 401×648)
- Por journey: % de éxito (un 409 esperado manejado no es fallo)
- KPIs de negocio: reservas creadas/canceladas/completadas, monto reservado, reembolsos, logins, recargas
- Ticker en vivo etiquetando [calentamiento] / [medicion]
- JSON en reports/sim-<run>.json para procesar después
El otro comando: npm run smoke
No genera carga: es una validación de contrato de 20 pasos en orden — health, registro, login, perfil, recarga, catálogo, disponibilidad (busca un tramo libre real), reserva con idempotencia, historial, cancelación con reembolso, ciclo de estados con admin, y revocación de token. Si algo responde distinto a como dice el contrato del backend, falla con ✗ y el detalle. Sirve como "¿está el backend sano y compatible?" antes de lanzar una corrida larga.
Los scripts
Script	Qué hace
npm run smoke	Contrato de endpoints (smoke.ts); combiná con -b y ADMIN_*
npm run sim	La corrida de tráfico (run por defecto)
npm run dev	tsx watch: reinicia al editar (desarrollo del simulador)
npm run build	tsc → dist/
npm start	Ejecuta dist/ (versión compilada)
npm run typecheck	tsc --noEmit (TS strict + noUncheckedIndexedAccess)
npm run lint	ESLint
En una frase: es un driver de tráfico stateful y determinista que habla la API real como si fuera la gente de la empresa, con métricas de performance y de negocio, y un smoke que prueba el contrato antes de estresar.
