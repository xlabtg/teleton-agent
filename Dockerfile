# ---- Build stage ----
FROM node:20-slim AS build

WORKDIR /app

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files and SDK workspace (needed for workspace resolution)
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/

# Install all deps (including devDependencies for build + SDK workspace)
RUN npm ci

# Copy source, build configs, and full SDK source
COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
COPY packages/ packages/

# Copy frontend source and install its deps
COPY web/ web/
RUN cd web && npm ci

# Build everything: SDK → backend (tsup) → frontend (vite)
RUN npm run build

# ---- Runtime stage ----
FROM node:20-slim

WORKDIR /app

# The runtime image ships no compilers. Native modules (better-sqlite3) are
# compiled once in the build stage and the prebuilt binary is copied in below,
# so python3/make/g++ are not needed here. WAV→OGG/Opus conversion for Telegram
# voice notes is done in-process via a WASM Opus encoder (see src/utils/audio.ts),
# so a system ffmpeg install is no longer required either.

# Copy package files and install production deps only
COPY package.json package-lock.json ./
RUN npm pkg delete scripts.prepare \
    && npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# Copy pre-built native module from build stage
COPY --from=build /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node

# Copy compiled code, bin wrapper, and templates
COPY --from=build /app/dist/ dist/
COPY bin/ bin/
COPY src/templates/ src/templates/

# Data directory for persistence
ENV TELETON_HOME=/data
VOLUME /data

# Run as non-root
RUN chown -R node:node /app
USER node

# WebUI port (when enabled)
EXPOSE 7777
# Management API port: health/readiness probes + Prometheus /metrics (when enabled)
EXPOSE 7778

# Liveness probe against the Management API /healthz endpoint.
# Uses Node directly (no curl in the slim image); -k equivalent via
# rejectUnauthorized:false for the self-signed Management API cert.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "const https=require('node:https');const r=https.request({host:'127.0.0.1',port:7778,path:'/healthz',rejectUnauthorized:false},res=>process.exit(res.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end()"

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["start"]
