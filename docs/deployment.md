# Deployment Guide

This guide covers every method of deploying Teleton Agent, from a quick global install to production-grade Docker and systemd setups.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Method 1: npm Global Install](#method-1-npm-global-install)
- [Method 2: Docker](#method-2-docker)
- [Method 3: Docker Compose](#method-3-docker-compose)
- [Method 4: From Source](#method-4-from-source)
- [Method 5: Kubernetes (Helm)](#method-5-kubernetes-helm)
- [systemd Service (VPS)](#systemd-service-vps)
- [Remote Management (API)](#remote-management-api)
- [Environment Variables](#environment-variables)
- [Health Check](#health-check)
- [Backup Strategy](#backup-strategy)
- [Updating](#updating)

---

## Prerequisites

Before deploying, make sure you have:

1. **Node.js 20+** (required by the `engines` field in `package.json`)
2. **npm** (ships with Node.js)
3. **Telegram API credentials** -- obtain `api_id` and `api_hash` from [my.telegram.org/apps](https://my.telegram.org/apps)
4. **LLM API key** -- from your chosen provider (Anthropic, OpenAI, Google, xAI, Groq, OpenRouter, Moonshot, Mistral, Cerebras, ZAI, MiniMax, Hugging Face, NVIDIA NIM, or Gocoon)
5. **Build tools** (only for source/Docker builds) -- `python3`, `make`, `g++` for native modules (`better-sqlite3`)

---

## Method 1: npm Global Install

The simplest deployment path. Suitable for personal use and quick testing.

```bash
# Install globally
npm install -g teleton

# Run the interactive setup wizard
teleton setup

# Start the agent
teleton start
```

The setup wizard will:
- Prompt for your Telegram API credentials
- Prompt for your LLM provider and API key
- Generate a TON wallet (or let you import one)
- Create `~/.teleton/config.yaml`

### First Run Authentication

On first launch, Telegram will send a login code to your phone. Enter it when prompted. If you have 2FA enabled, you will also be prompted for your password. After successful authentication, a session file is saved at `~/.teleton/` and subsequent launches will not require re-authentication.

---

## Method 2: Docker

The official Docker image is published to GitHub Container Registry on every
release. It is a multi-arch image (`linux/amd64`, `linux/arm64`), so it runs
natively on both x86 servers and ARM hosts (Apple Silicon, AWS Graviton,
Raspberry Pi).

### Verify the Signature (optional)

Release images are signed keylessly with [cosign](https://github.com/sigstore/cosign)
via GitHub OIDC. You can verify the supply-chain provenance before running:

```bash
cosign verify ghcr.io/xlabtg/teleton-agent:latest \
  --certificate-identity-regexp '^https://github.com/xlabtg/teleton-agent/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

### Pull and Run

```bash
docker run -d \
  --name teleton \
  --restart unless-stopped \
  -v teleton-data:/data \
  -p 127.0.0.1:7777:7777 \
  ghcr.io/xlabtg/teleton-agent
```

### Image Details

The Docker image uses a multi-stage build:

- **Build stage**: Node.js 20-slim with build tools (`python3`, `make`, `g++`), compiles the full project (SDK, backend via tsup, frontend via Vite)
- **Runtime stage**: Node.js 20-slim with production dependencies only. Build tools are purged after native module compilation
- **Data volume**: Mounted at `/data` (set via `TELETON_HOME=/data` in the image)
- **Entrypoint**: `node dist/cli/index.js`
- **Default command**: `start`
- **Exposed port**: `7777` (WebUI, when enabled)
- **Runs as**: non-root `node` user

### Interactive Setup with Docker

Since the first run requires interactive authentication with Telegram, run setup interactively first:

```bash
# Run setup interactively
docker run -it --rm \
  -v teleton-data:/data \
  ghcr.io/xlabtg/teleton-agent setup

# Then start the agent
docker run -d \
  --name teleton \
  --restart unless-stopped \
  -v teleton-data:/data \
  -p 127.0.0.1:7777:7777 \
  ghcr.io/xlabtg/teleton-agent
```

### Passing Configuration via Environment

For CI/CD and container orchestration, pass credentials as environment variables rather than baking them into a config file:

```bash
docker run -d \
  --name teleton \
  --restart unless-stopped \
  -e TELETON_API_KEY="sk-ant-..." \
  -e TELETON_TG_API_ID="12345678" \
  -e TELETON_TG_API_HASH="0123456789abcdef" \
  -e TELETON_TG_PHONE="+1234567890" \
  -e TELETON_WEBUI_ENABLED="true" \
  -v teleton-data:/data \
  -p 127.0.0.1:7777:7777 \
  ghcr.io/xlabtg/teleton-agent
```

Note: A `config.yaml` must still exist in the data volume with at minimum the non-overridden fields. Run `setup` first to create it.

---

## Method 3: Docker Compose

The repository ships a ready-to-use [`compose.yaml`](../compose.yaml) at the
project root. From a checkout (or after copying `compose.yaml` and `.env.example`
to your host) you can bring up the full stack with a single command.

```bash
# (optional) provide credentials via a local .env file
cp .env.example .env
# edit .env

# Initial setup (interactive Telegram login)
docker compose run --rm agent setup

services:
  teleton:
    image: ghcr.io/xlabtg/teleton-agent:latest
    container_name: teleton
    restart: unless-stopped
    ports:
      - "127.0.0.1:7777:7777"  # WebUI (remove if not using)
      - "7778:7778"  # Management API (health probes + Prometheus metrics)
    volumes:
      - teleton-data:/data
    environment:
      - TELETON_WEBUI_ENABLED=true
      - TELETON_WEBUI_HOST=0.0.0.0  # Bind to all interfaces inside container
      - TELETON_API_ENABLED=true    # Management API (/healthz, /readyz, /metrics)
      - LOG_FORMAT=json             # Structured JSON logs for aggregation
      # Optionally override credentials via env vars:
      # - TELETON_API_KEY=sk-ant-...
      # - TELETON_TG_API_ID=12345678
      # - TELETON_TG_API_HASH=0123456789abcdef
      # - TELETON_TG_PHONE=+1234567890
    # The official image ships a built-in HEALTHCHECK against /healthz, so this
    # block is optional. It is shown here for clarity / custom images.
    healthcheck:
      # Node-based check (the slim image has no curl); skips self-signed cert verification.
      test:
        - CMD
        - node
        - -e
        - "const h=require('node:https');h.request({host:'127.0.0.1',port:7778,path:'/healthz',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).end()"
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

# Start in the background
docker compose up -d
```

The shipped `compose.yaml` configures:

- The published image `ghcr.io/xlabtg/teleton-agent:latest` (override with the
  `TELETON_IMAGE` variable, or uncomment the `build:` block to build locally)
- `restart: unless-stopped`
- A named `teleton-data` volume mounted at `/data`
- The WebUI enabled and published on host port `7777` (override with
  `TELETON_WEBUI_PORT`)
- A `healthcheck` that probes the `/health` endpoint with Node's built-in `fetch`
- Optional credential overrides loaded from `.env` (see `.env.example`)

### Using a Host Directory Instead of a Named Volume

If you prefer direct access to the data directory (for easier backups or config
editing), replace the `teleton-data:/data` volume mapping in `compose.yaml` with:

```yaml
volumes:
  - ~/.teleton:/data
```

### Commands

```bash
# View logs
docker compose logs -f agent

# Stop
docker compose down

# Update to latest image
docker compose pull && docker compose up -d
```

---

## Method 4: From Source

For development or when you need to customize the agent.

```bash
# Clone the repository
git clone https://github.com/xlabtg/teleton-agent.git
cd teleton-agent

# Install dependencies (includes SDK workspace)
npm install

# Install frontend dependencies
cd web && npm install && cd ..

# Build everything: SDK -> backend (tsup) -> frontend (Vite)
npm run build

# Run setup wizard
node dist/cli/index.js setup

# Start the agent
node dist/cli/index.js start
```

### Development Mode

For active development with auto-reload:

```bash
# Backend with tsx watch
npm run dev

# Frontend dev server (separate terminal)
npm run dev:web
```

### Build Structure

The build process (`npm run build`) runs three steps in sequence:

1. `build:sdk` -- Compiles the `@teleton-agent/sdk` package in `packages/sdk/`
2. `build:backend` -- Compiles the main application with `tsup` to `dist/`
3. `build:web` -- Compiles the React frontend with Vite to `dist/web/`

The backend must build before the frontend because tsup cleans the output folder.

---

## Method 5: Kubernetes (Helm)

A minimal Helm chart lives in [`helm/teleton-agent/`](../helm/teleton-agent). It
renders a single-replica `Deployment` (`Recreate` strategy, since the agent owns
one Telegram session and a SQLite DB on a `ReadWriteOnce` volume), a `Service`, a
`PersistentVolumeClaim` for `/data`, and an optional `Secret` for credentials.

```bash
# Install from a checkout of the repository
helm install teleton ./helm/teleton-agent \
  --namespace teleton --create-namespace

# First-run setup is interactive — run it inside the pod, then restart
kubectl exec -it -n teleton deploy/teleton-teleton-agent -- node dist/cli/index.js setup
kubectl rollout restart -n teleton deploy/teleton-teleton-agent
```

Provide credentials non-interactively via `--set secrets.TELETON_API_KEY=...` (or
reference an existing Secret with `--set existingSecret=my-secret`). The WebUI
`/health` endpoint backs the liveness/readiness probes. See the
[chart README](../helm/teleton-agent/README.md) and
[`values.yaml`](../helm/teleton-agent/values.yaml) for all options.

---

## systemd Service (VPS)

For running Teleton Agent as a persistent service on a Linux VPS.

### Create the Service File

```ini
# /etc/systemd/system/teleton.service

[Unit]
Description=Teleton AI Agent for Telegram
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=teleton
Group=teleton
WorkingDirectory=/home/teleton

# Using global npm install
ExecStart=/usr/bin/teleton start

# Or using source install:
# ExecStart=/usr/bin/node /home/teleton/teleton-agent/dist/cli/index.js start

Restart=on-failure
RestartSec=10

# Environment
Environment=NODE_ENV=production
Environment=TELETON_HOME=/home/teleton/.teleton
# Environment=TELETON_WEBUI_ENABLED=true

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/teleton/.teleton
PrivateTmp=true

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=teleton

[Install]
WantedBy=multi-user.target
```

### Enable and Start

```bash
# Create a dedicated user
sudo useradd -r -m -s /bin/bash teleton

# Copy config to the user's home
sudo -u teleton mkdir -p /home/teleton/.teleton
sudo cp ~/.teleton/config.yaml /home/teleton/.teleton/
sudo chown -R teleton:teleton /home/teleton/.teleton

# Install teleton globally (as root or with sudo)
sudo npm install -g teleton

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable teleton
sudo systemctl start teleton

# Check status
sudo systemctl status teleton

# View logs
sudo journalctl -u teleton -f
```

---

## Remote Management (API)

The Management API provides an HTTPS control plane for administering a deployed agent without SSH. See the full [Management API documentation](management-api.md) for endpoint details.

### Enable on an existing deployment

Add to `config.yaml`:

```yaml
api:
  enabled: true
  port: 7778
```

Or via environment:

```bash
TELETON_API_ENABLED=true teleton start
```

The API key is generated on first start and printed to the log. Use `--json-credentials` to capture it programmatically.

### Bootstrap a fresh VPS (no config needed)

```bash
teleton start --api --json-credentials > /tmp/creds.json
```

This starts the API server without any configuration. Use the `/v1/setup/*` endpoints to configure the agent remotely, then `POST /v1/agent/start` to boot it.

### systemd with API

Update the service file to expose the API:

```ini
Environment=TELETON_API_ENABLED=true
# Optionally output credentials to journal on first start:
# Environment=TELETON_JSON_CREDENTIALS=true
```

### Docker with API

Expose port `7778` alongside the WebUI:

```bash
docker run -d \
  --name teleton \
  --restart unless-stopped \
  -e TELETON_API_ENABLED=true \
  -v teleton-data:/data \
  -p 127.0.0.1:7777:7777 \
  -p 7778:7778 \
  ghcr.io/xlabtg/teleton-agent
```

---

## Environment Variables

Complete list of environment variables recognized by Teleton Agent:

| Variable | Purpose | Default |
|----------|---------|---------|
| `TELETON_HOME` | Root data directory | `~/.teleton` |
| `TELETON_API_KEY` | LLM provider API key | from config |
| `TELETON_TG_API_ID` | Telegram API ID | from config |
| `TELETON_TG_API_HASH` | Telegram API hash | from config |
| `TELETON_TG_PHONE` | Telegram phone number | from config |
| `TELETON_WEBUI_ENABLED` | Enable WebUI (`"true"` / `"false"`) | from config |
| `TELETON_WEBUI_PORT` | WebUI port | `7777` |
| `TELETON_WEBUI_BIND` | Compose bind address (`0.0.0.0` opts into external access) | `127.0.0.1` |
| `TELETON_WEBUI_HOST` | WebUI bind address | `127.0.0.1` |
| `TELETON_API_ENABLED` | Enable Management API | `false` |
| `TELETON_API_PORT` | Management API HTTPS port | `7778` |
| `TELETON_JSON_CREDENTIALS` | Output API credentials as JSON on startup | `false` |
| `DEBUG` | Enable debug logging | unset |
| `VERBOSE` | Enable verbose logging | unset |
| `NODE_ENV` | Node.js environment | `"development"` |

Environment variables always take precedence over `config.yaml` values.

---

## Health Check

The Management API (enable with `TELETON_API_ENABLED=true`) exposes dedicated
probes on port `7778` (HTTPS, self-signed cert) for orchestrators:

| Endpoint | Purpose | Codes |
|----------|---------|-------|
| `GET /healthz` | Liveness — process is alive | `200` |
| `GET /readyz` | Readiness — agent fully initialised | `200` ready / `503` starting |
| `GET /metrics` | Prometheus metrics (see [Management API docs](management-api.md#metrics)) | `200` |

```bash
curl -fk https://localhost:7778/healthz   # {"status":"ok"}
curl -fk https://localhost:7778/readyz    # 200 when running, 503 during startup
```

The official Docker image ships a built-in `HEALTHCHECK` against `/healthz`, so
no extra configuration is needed. To override it (e.g. on a custom image), use a
Node-based check — the slim runtime image has no `curl`:

```yaml
services:
  teleton:
    # ...
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "const h=require('node:https');h.request({host:'127.0.0.1',port:7778,path:'/healthz',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).end()"
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

Or in Kubernetes liveness/readiness probes — map `/healthz` to `livenessProbe`
and `/readyz` to `readinessProbe`:

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 7778, scheme: HTTPS }
  initialDelaySeconds: 10
  periodSeconds: 30
readinessProbe:
  httpGet: { path: /readyz, port: 7778, scheme: HTTPS }
  initialDelaySeconds: 10
  periodSeconds: 10
```

> The WebUI also exposes a simpler `GET http://localhost:7777/health` endpoint
> when enabled, but `/healthz` + `/readyz` on the Management API are preferred
> for production orchestration.

---

## Backup Strategy

All persistent data is stored in the `~/.teleton/` directory (or `TELETON_HOME`). Regular backups of this directory are sufficient for full recovery.

### Critical Files

| Path | Contents | Sensitivity |
|------|----------|-------------|
| `config.yaml` | All configuration | Contains API keys |
| `wallet.json` | TON wallet mnemonic + keys | **Highly sensitive** (0600 perms) |
| `teleton_session/` | Telegram session | Grants account access |
| `memory.db` | Conversation memory + sessions (SQLite) | Contains chat history |
| `plugins/` | Installed plugins | Reproducible |
| `plugins/data/` | Plugin databases + secrets | May contain sensitive data |
| `workspace/` | Agent workspace files | User content |

### Backup Commands

```bash
# Simple backup
tar -czf teleton-backup-$(date +%Y%m%d).tar.gz ~/.teleton/

# Exclude transient files
tar -czf teleton-backup-$(date +%Y%m%d).tar.gz \
  --exclude='*.db-wal' \
  --exclude='*.db-shm' \
  ~/.teleton/

# Restore
tar -xzf teleton-backup-20260216.tar.gz -C ~/
```

### Docker Volume Backup

```bash
# Stop the container first for consistency
docker compose stop teleton

# Backup the volume
docker run --rm \
  -v teleton-data:/data \
  -v $(pwd):/backup \
  alpine tar -czf /backup/teleton-backup-$(date +%Y%m%d).tar.gz -C /data .

# Restart
docker compose start teleton
```

---

## Updating

### npm Global Install

```bash
npm update -g teleton
# Or install a specific version:
npm install -g teleton@0.5.2
```

### Docker

```bash
docker pull ghcr.io/xlabtg/teleton-agent:latest
docker stop teleton && docker rm teleton
docker run -d \
  --name teleton \
  --restart unless-stopped \
  -v teleton-data:/data \
  -p 127.0.0.1:7777:7777 \
  ghcr.io/xlabtg/teleton-agent
```

Or with Docker Compose:

```bash
docker compose pull
docker compose up -d
```

### From Source (via install.sh)

Re-run the one-liner installer to update:

```bash
curl -fsSL https://raw.githubusercontent.com/xlabtg/teleton-agent/main/install.sh | bash
```

The installer verifies that `~/.teleton-app` still points to the official repository before pulling. If it detects an unexpected `origin` URL or uncommitted local changes it aborts with a clear error, so you can investigate before any code runs.

If you see an unexpected origin error, remove the directory and re-run:

```bash
rm -rf ~/.teleton-app
curl -fsSL https://raw.githubusercontent.com/xlabtg/teleton-agent/main/install.sh | bash
```

### Version Pinning

For production stability, pin to a specific version tag:

```bash
# Docker
ghcr.io/xlabtg/teleton-agent:v0.5.2

# npm
npm install -g teleton@0.5.2
```
