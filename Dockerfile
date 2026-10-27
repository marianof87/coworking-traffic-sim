# syntax=docker/dockerfile:1
# Simulador de tráfico para proyectoXP. Lo levanta el compose.yaml de proyectoXP
# (servicio "sim"); también sirve solo:
#   docker build -t coworking-traffic-sim . && docker run --rm coworking-traffic-sim smoke -b http://host:3000

# ---- build: compila TypeScript ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime: solo dependencias de producción ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Los informes JSON se escriben en /app/reports.
RUN mkdir reports && chown node:node reports
USER node
ENTRYPOINT ["node", "dist/index.js"]
# Por defecto: modo servicio, a la espera de los botones del monitor.
# Una corrida suelta: docker run --rm coworking-traffic-sim run -d 1m -r 10
CMD ["control"]
