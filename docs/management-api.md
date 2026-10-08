# Management API

The Management API is an independent HTTPS server that enables remote configuration, lifecycle management, and monitoring of Teleton agents via typed HTTP endpoints — replacing SSH-based management.

It runs on port `7778` by default, uses self-signed TLS, and authenticates requests with `tltn_`-prefixed API keys.

---

## Table of Contents

- [Quick Start](#quick-start)
- [API Reference (OpenAPI)](#api-reference-openapi)
- [Bootstrap Mode](#bootstrap-mode)
- [Authentication](#authentication)
- [TLS Certificates](#tls-certificates)
- [Endpoints](#endpoints)
  - [Health Probes](#health-probes)
  - [Metrics](#metrics)
  - [Agent Lifecycle](#agent-lifecycle)
  - [System](#system)
  - [Auth](#auth)
  - [Logs](#logs)
  - [Sessions](#sessions)
  - [Reused WebUI Routes](#reused-webui-routes)
- [Rate Limiting](#rate-limiting)
- [Security](#security)
- [Configuration](#configuration)
- [Structured Logging](#structured-logging)
- [CLI Commands](#cli-commands)
- [Error Format](#error-format)
- [Examples](#examples)

---

## Quick Start

### 1. Enable in config.yaml

```yaml
api:
  enabled: true
  port: 7778          # default
  # allowed_ips: []   # empty = allow all authenticated requests
```

### 2. Start the agent

```bash
teleton start
```

On first start, a `tltn_`-prefixed API key is generated and printed to the log. Copy it — it won't be shown again.

To get the key as JSON (useful for automation):

```bash
teleton start --json-credentials
# Output: {"apiKey":"tltn_...","fingerprint":"a1b2c3...","port":7778}
```

### 3. Make your first call

```bash
curl -k https://localhost:7778/v1/agent/status \
  -H "Authorization: Bearer tltn_your_key_here"
```

> **Note**: `-k` skips TLS verification for self-signed certs. For production, pin the certificate fingerprint instead (see [TLS Certificates](#tls-certificates)).

---

## API Reference (OpenAPI)

The complete, machine-readable API reference is published as an OpenAPI 3.1 document covering **every `/v1` endpoint**. It is generated directly from the live router, so it can never drift from the implementation, and is linted in CI with `redocly lint`.

| Artifact | Location |
|----------|----------|
| OpenAPI spec (JSON) | [`docs/api-reference/openapi.json`](api-reference/openapi.json) |
| OpenAPI spec (YAML) | [`docs/api-reference/openapi.yaml`](api-reference/openapi.yaml) |
| Static Swagger UI | [`docs/api-reference/index.html`](api-reference/index.html) |

### Interactive docs at runtime

When the server runs in development (`NODE_ENV != production`) or with `api.docs_enabled: true`, interactive Swagger UI is served by the agent itself:

- **`GET /api/docs`** — Swagger UI (unauthenticated)
- **`GET /api/openapi.json`** — the spec (unauthenticated)
- **`GET /v1/openapi.json`** — the same spec behind bearer auth

```yaml
api:
  enabled: true
  docs_enabled: true   # serve Swagger UI at /api/docs even in production
```

> The `/api/docs` and `/api/openapi.json` endpoints are exposed only as documentation plumbing and are intentionally excluded from the spec itself.

### Regenerating the spec

```bash
npm run generate:openapi   # rewrites docs/api-reference/{openapi.json,openapi.yaml,index.html}
npm run lint:openapi       # validates the spec with redocly
```

CI fails if the committed artifacts are out of date, so regenerate and commit whenever routes change.

---

## Bootstrap Mode

Start the API without an existing `config.yaml` — useful for provisioning a fresh VPS entirely over HTTP.

```bash
teleton start --api
```

This starts **only** the Management API with null dependencies. All `/v1/setup/*` endpoints are available for remote configuration. Once setup is complete:

```bash
# Complete setup via /v1/setup endpoints, then start the agent:
curl -k https://localhost:7778/v1/agent/start \
  -X POST \
  -H "Authorization: Bearer tltn_..."
```

The agent boots, and all other endpoints become available. Routes that require the agent return `503 Service Unavailable` until it starts.

### Bootstrap flow

```
teleton start --api
       │
       ▼
  API server starts (null deps)
       │
       ▼
  POST /v1/setup/* ── configure provider, Telegram, wallet...
       │
       ▼
  POST /v1/agent/start ── creates TeletonApp, hot-swaps deps
       │
       ▼
  All /v1/* endpoints operational
```

---

## Authentication

All `/v1/*` routes require a Bearer token in the `Authorization` header:

```
Authorization: Bearer tltn_<base64url-encoded key>
```

### Key format

- Prefix: `tltn_`
- Payload: 32 random bytes, base64url-encoded
- Example: `tltn_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901234`

### How it works

1. The raw API key is shown **once** at first start (or via `--json-credentials`)
2. Only the **scrypt hash** is persisted in `config.yaml` (`api.key_hash`)
3. On each request, the provided key is hashed and compared using `timingSafeEqual` (constant-time, timing-attack resistant)

### Key rotation

```bash
teleton api-rotate-key
```

Generates a new key, prints it, and persists the new hash to `config.yaml`. The old key is immediately invalidated.

---

## TLS Certificates

The API generates a self-signed certificate on first start, stored at:

- `~/.teleton/api-cert.pem` (certificate)
- `~/.teleton/api-key.pem` (private key)

Both files have `0o600` permissions (owner read/write only).

### Certificate details

| Property | Value |
|----------|-------|
| Algorithm | RSA 2048-bit, SHA-256 |
| Validity | 2 years |
| SANs | `localhost` (DNS), `127.0.0.1` (IPv4), `::1` (IPv6) |
| Auto-renewal | Regenerated automatically if expired |

### Fingerprint

Get the TLS fingerprint for certificate pinning:

```bash
teleton api-fingerprint
# Output: a1b2c3d4e5f6...  (SHA-256, 64 hex chars)
```

Or via `--json-credentials` at startup.

### Using the fingerprint with curl

```bash
# Instead of -k, pin the certificate:
curl --cacert ~/.teleton/api-cert.pem \
  https://localhost:7778/healthz
```

---

## Endpoints

### Health Probes

No authentication required.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Liveness probe — always returns `{ "status": "ok" }` |
| GET | `/readyz` | Readiness probe — `200` if agent running, `503` with setup status otherwise |

**`/readyz` response when agent is not running:**

```json
{
  "status": "not_ready",
  "state": "stopped",
  "setup": {
    "workspace": true,
    "config": true,
    "wallet": true,
    "telegram_session": true,
    "embeddings_cached": false
  }
}
```

### Metrics

No authentication required.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/metrics` | Prometheus text exposition format (`text/plain; version=0.0.4`) |

Scrape it directly with Prometheus, Grafana Agent, VictoriaMetrics, etc.:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: teleton
    scheme: https
    tls_config:
      insecure_skip_verify: true   # self-signed cert; pin the fingerprint in production
    static_configs:
      - targets: ["localhost:7778"]
```

**Exposed metrics:**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `teleton_tasks_total` | counter | `status` | Autonomous tasks by terminal status (`completed`, `failed`, `cancelled`) |
| `teleton_llm_requests_total` | counter | `provider`, `model`, `status` | LLM calls by provider/model and outcome (`success`, `error`) |
| `teleton_llm_duration_seconds` | histogram | `provider`, `model` | LLM request latency |
| `teleton_memory_items_total` | gauge | — | Vector-memory (knowledge) entry count |
| `teleton_active_sessions` | gauge | — | Telegram sessions active in the last 30 minutes |
| `process_*` / `nodejs_*` | various | — | Process uptime, memory, CPU, GC and event-loop metrics via `prom-client` |

**Sample output:**

```text
# HELP teleton_llm_requests_total Total LLM requests by provider, model and outcome
# TYPE teleton_llm_requests_total counter
teleton_llm_requests_total{provider="anthropic",model="claude-opus-4-8",status="success"} 42

# HELP teleton_active_sessions Number of Telegram sessions active in the last 30 minutes
# TYPE teleton_active_sessions gauge
teleton_active_sessions 3
```

### Agent Lifecycle

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/agent/start` | Start the agent (fire-and-forget). Returns `409` if already running or stopping. |
| POST | `/v1/agent/stop` | Stop the agent. Returns `409` if already stopped or starting. |
| POST | `/v1/agent/restart` | Stop then start (fire-and-forget). Returns `409` during transitions. |
| GET | `/v1/agent/status` | Returns `{ state, uptime, error }` |
| GET | `/v1/agent/events` | SSE stream of lifecycle state changes |

**Agent states:** `stopped` → `starting` → `running` → `stopping` → `stopped`

**SSE event format (`/v1/agent/events`):**

```
event: status
id: 1710312345678
data: {"state":"running","error":null,"timestamp":1710312345678}
```

A `ping` event is sent every 30 seconds to keep the connection alive.

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/system/version` | Teleton version, Node.js version, OS, arch, API version |
| GET | `/v1/system/info` | CPU model/cores/load, memory usage, process/system uptime |

**Example response (`/v1/system/version`):**

```json
{
  "teleton": "0.8.3",
  "node": "v22.0.0",
  "os": "linux",
  "arch": "x64",
  "apiVersion": "1.0.0"
}
```

### Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/auth/validate` | Validates the API key. Returns `{ "valid": true, "keyPrefix": "tltn_aBcD..." }` |

Useful for testing connectivity and key validity without side effects.

### Logs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/api-logs/recent?lines=100` | Returns recent log lines (max 1000) |
| GET | `/v1/api-logs/stream` | SSE stream of live log entries |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| DELETE | `/v1/api-memory/sessions/:chatId` | Delete a specific chat session. Returns `404` if not found. |
| POST | `/v1/api-memory/sessions/prune` | Prune sessions older than N days. Body: `{ "maxAgeDays": 30 }` (default: 30). |

### OpenAPI Spec

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/openapi.json` | OpenAPI 3.1 specification |

### Reused WebUI Routes

The API mounts stable WebUI route factories under `/v1/`, giving remote management clients access to dashboard features via HTTP:

| Prefix | Description |
|--------|-------------|
| `/v1/status` | Agent status and metrics |
| `/v1/tools` | Tool inventory and configuration |
| `/v1/logs` | Conversation logs |
| `/v1/memory` | Memory search and management |
| `/v1/soul` | System prompt (read-only) |
| `/v1/plugins` | Plugin management |
| `/v1/mcp` | MCP server configuration |
| `/v1/workspace` | Workspace file management |
| `/v1/tasks` | Scheduled tasks |
| `/v1/config` | Configuration read/write |
| `/v1/marketplace` | Plugin marketplace |
| `/v1/hooks` | Hook management |
| `/v1/ton-proxy` | TON Proxy control |
| `/v1/notifications` | In-app notifications and unread counts |
| `/v1/cache` | Predictive cache inspection and controls |
| `/v1/metrics` | Operational metrics |
| `/v1/sessions` | Chat session search and inspection |
| `/v1/analytics` | Usage analytics |
| `/v1/anomalies` | Anomaly detection data |
| `/v1/security` | Security status and zero-trust policy data |
| `/v1/audit` | Audit trail search and stream |
| `/v1/health-check` | Composite application health checks |
| `/v1/export` | Safe configuration and prompt export/import |
| `/v1/workflows` | Workflow definitions and scheduling |
| `/v1/pipelines` | Pipeline definitions and execution |
| `/v1/self-improvement` | Self-improvement run history and controls |
| `/v1/autonomous` | Autonomous task queue and policy routes |
| `/v1/predictions` | Prediction service data |
| `/v1/context` | Temporal context analytics |
| `/v1/dashboards` | Dynamic dashboard layout and widgets |
| `/v1/widgets` | Widget generator routes |
| `/v1/network` | Agent network registry and delegation routes |
| `/v1/setup` | Setup wizard (works without agent) |

WebUI route groups intentionally not mirrored in the Management API:

| WebUI Prefix | Reason |
|--------------|--------|
| `/api/agent-network` | Signed inter-agent ingress with protocol authentication, not API key authentication |
| `/api/agent-actions` | Browser-specific control helper; management clients use `/v1/agent` |
| `/api/groq` | WebUI provider configuration helper |
| `/api/mtproto` | WebUI setup/configuration helper |

> Routes that require agent subsystems (memory, bridge, etc.) return `503` with an RFC 9457 error if the agent is not running.

---

## Rate Limiting

Three tiers of rate limiting apply to all `/v1/*` routes:

| Tier | Limit | Applies to |
|------|-------|------------|
| Global | 60 requests/min | All methods |
| Mutations | 10 requests/min | POST, PUT, DELETE |
| Reads | 300 requests/min | GET |

Rate limits are keyed per API key prefix. When exceeded, the server returns `429 Too Many Requests` with a `Retry-After` header.

---

## Security

### IP Whitelist

Restrict access to specific IPs via `api.allowed_ips` in config. When the list is empty (default), any authenticated request is accepted.

```yaml
api:
  allowed_ips:
    - "203.0.113.10"
    - "198.51.100.0/24"
```

Non-whitelisted IPs receive `403 Forbidden`. IPv4-mapped IPv6 addresses (`::ffff:X.X.X.X`) are normalized automatically.

### Brute-Force Protection

- **10 failed attempts** per IP within a 5-minute window triggers a **15-minute block**
- Blocked IPs receive `429 Too Many Requests` with `Retry-After: 900`
- Failed attempt counters are cleaned up every 5 minutes

### Audit Logging

All mutating operations (POST, PUT, DELETE) are logged at `warn` level with:

```json
{
  "audit": true,
  "event": "api_mutation",
  "method": "POST",
  "path": "/v1/agent/restart",
  "statusCode": 200,
  "durationMs": 12,
  "sourceIp": "203.0.113.10",
  "keyPrefix": "tltn_aBcD",
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

Request bodies, headers, and secrets are **never** logged.

### Security Headers

Every response includes:

| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-Request-Id` | UUID (auto-generated or forwarded from client) |

---

## Configuration

### config.yaml

```yaml
api:
  enabled: true         # Enable the Management API (default: false)
  port: 7778            # HTTPS port (default: 7778)
  key_hash: ""          # scrypt hash of the API key (auto-generated on first start)
  allowed_ips: []       # IP whitelist (empty = allow all)
```

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `TELETON_API_ENABLED` | Enable Management API | `false` |
| `TELETON_API_PORT` | HTTPS port | `7778` |
| `TELETON_JSON_CREDENTIALS` | Output credentials as JSON on startup | `false` |
| `LOG_FORMAT` | `json` emits structured JSON logs (see below) | _(pretty)_ |

Environment variables take precedence over `config.yaml`.

---

## Structured Logging

Logs are pretty-printed for interactive use by default. For production deployments
that ship logs to an aggregator (Loki, ELK, Datadog, …), set `LOG_FORMAT=json` to
emit one JSON object per line on stdout:

```bash
LOG_FORMAT=json teleton start
```

```json
{"level":30,"time":"2026-05-29T21:46:28.581Z","module":"ManagementAPI","msg":"Management API server running on https://127.0.0.1:7778"}
```

Secrets (`apiKey`, `password`, `token`, `mnemonic`, …) are automatically redacted as
`[REDACTED]`. The log level is controlled separately via `TELETON_LOG_LEVEL`
(`fatal|error|warn|info|debug|trace`) or `logging.level` in `config.yaml`.

### Shipping logs with Promtail (Grafana Loki)

```yaml
# promtail-config.yaml
scrape_configs:
  - job_name: teleton
    static_configs:
      - targets: [localhost]
        labels:
          job: teleton
          __path__: /var/log/teleton/*.log
    pipeline_stages:
      - json:
          expressions:
            level: level
            module: module
            msg: msg
            time: time
      - timestamp:
          source: time
          format: RFC3339
      - labels:
          module:
```

### Shipping logs with Filebeat (ELK)

```yaml
# filebeat.yml
filebeat.inputs:
  - type: filestream
    paths:
      - /var/log/teleton/*.log
    parsers:
      - ndjson:
          target: ""
          overwrite_keys: true
output.elasticsearch:
  hosts: ["http://localhost:9200"]
```

When running under Docker, point your shipper at the container's stdout
(`docker logs` / the json-file driver) instead of a file path.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `teleton start` | Start agent (API starts if `api.enabled: true`) |
| `teleton start --api` | Bootstrap mode — API only, no config needed |
| `teleton start --json-credentials` | Print `{"apiKey","fingerprint","port"}` to stdout |
| `teleton api-rotate-key` | Generate new API key and persist hash |
| `teleton api-fingerprint` | Print TLS certificate SHA-256 fingerprint |

---

## Error Format

All errors follow [RFC 9457 Problem Detail](https://www.rfc-editor.org/rfc/rfc9457) with `Content-Type: application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Invalid API key"
}
```

| Status | When |
|--------|------|
| `401` | Missing, malformed, or invalid API key |
| `403` | IP not in whitelist |
| `409` | Agent state conflict (e.g., start when already running) |
| `413` | Request body exceeds 2MB |
| `429` | Rate limit or brute-force block exceeded |
| `503` | Agent subsystem not available (not started yet) |

---

## Examples

### Check agent status

```bash
curl -k https://localhost:7778/v1/agent/status \
  -H "Authorization: Bearer $TELETON_API_KEY"
```

### Restart the agent

```bash
curl -k https://localhost:7778/v1/agent/restart \
  -X POST \
  -H "Authorization: Bearer $TELETON_API_KEY"
```

### Stream lifecycle events

```bash
curl -k -N https://localhost:7778/v1/agent/events \
  -H "Authorization: Bearer $TELETON_API_KEY"
```

### Get system info

```bash
curl -k https://localhost:7778/v1/system/info \
  -H "Authorization: Bearer $TELETON_API_KEY"
```

### Prune old sessions

```bash
curl -k https://localhost:7778/v1/api-memory/sessions/prune \
  -X POST \
  -H "Authorization: Bearer $TELETON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"maxAgeDays": 7}'
```

### Validate your API key

```bash
curl -k https://localhost:7778/v1/auth/validate \
  -X POST \
  -H "Authorization: Bearer $TELETON_API_KEY"
```

### Bootstrap a fresh VPS

```bash
# 1. Start API-only mode
teleton start --api --json-credentials > /tmp/creds.json

# 2. Extract key
KEY=$(jq -r .apiKey /tmp/creds.json)

# 3. Check readiness (see what's missing)
curl -k https://localhost:7778/readyz

# 4. Configure via setup endpoints
curl -k https://localhost:7778/v1/setup/provider \
  -X POST \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","api_key":"sk-ant-..."}'

# 5. Start the agent
curl -k https://localhost:7778/v1/agent/start \
  -X POST \
  -H "Authorization: Bearer $KEY"
```

### Docker with API enabled

```bash
docker run -d \
  --name teleton \
  --restart unless-stopped \
  -e TELETON_API_ENABLED=true \
  -e TELETON_JSON_CREDENTIALS=true \
  -v teleton-data:/data \
  -p 127.0.0.1:7777:7777 \
  -p 7778:7778 \
  ghcr.io/xlabtg/teleton-agent
```

### Docker Compose

```yaml
services:
  teleton:
    image: ghcr.io/xlabtg/teleton-agent:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:7777:7777"   # WebUI
      - "7778:7778"   # Management API
    volumes:
      - teleton-data:/data
    environment:
      - TELETON_API_ENABLED=true
    healthcheck:
      test: ["CMD", "curl", "-kf", "https://localhost:7778/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3
```
