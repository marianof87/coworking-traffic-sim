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
# Por defecto: 3 minutos de tráfico moderado. Se pisa con `compose run sim ...`.
CMD ["run", "-d", "3m", "-r", "10", "-u", "8"]
