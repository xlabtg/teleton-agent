import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import Database from "better-sqlite3";
import { ensureSchema } from "../../memory/schema.js";
import { getEventBus, resetEventBusForTesting } from "../../services/event-bus.js";
import {
  getWebhookDispatcher,
  resetWebhookDispatcherForTesting,
} from "../../services/webhook-dispatcher.js";
import { WorkflowScheduler } from "../../services/workflow-scheduler.js";
import { WorkflowStore } from "../../services/workflows.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../middleware/csrf.js";
import type { WebUIServerDeps } from "../types.js";

vi.mock("../../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock("../../services/audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/audit.js")>();
  return {
    ...actual,
    initAudit: () => ({
      log: vi.fn(),
    }),
  };
});

vi.mock("../../services/audit-trail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/audit-trail.js")>();
  return {
    ...actual,
    initAuditTrail: () => ({
      recordEvent: vi.fn(),
    }),
  };
});

import { WebUIServer } from "../server.js";

const WEBHOOK_TEST_KEY = "33".repeat(32);

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      config TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_run_at INTEGER,
      run_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_fired_bucket INTEGER
    );
  `);
  return db;
}

function buildDeps(db: Database.Database): WebUIServerDeps {
  const scheduler = new WorkflowScheduler(db);

  return {
    configPath: "/tmp/teleton-test-config.yaml",
    config: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      auth_token: "webui-test-token",
      cors_origins: ["*"],
      log_requests: false,
    },
    memory: {
      db,
      embedder: {},
      knowledge: {},
    },
    workflowScheduler: () => scheduler,
    agent: {
      getConfig: () => ({
        agent: { provider: "anthropic", model: "claude-opus-4-6" },
        telegram: {},
        meta: {},
      }),
    },
    bridge: {},
    toolRegistry: {
      getAll: () => [],
    },
    plugins: [],
    mcpServers: [],
  } as unknown as WebUIServerDeps;
}

function fetchApp(server: WebUIServer): Hono {
  return (server as unknown as { app: Hono }).app;
}

function extractCsrfCookie(res: Response): string {
  const setCookie = res.headers.get("Set-Cookie");
  const match = setCookie?.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;]+)`));
  expect(match?.[1]).toBeTruthy();
  return match![1];
}

describe("WebUIServer public signed ingress middleware bypass", () => {
  let db: Database.Database;
  let app: Hono;
  let previousWebhookKey: string | undefined;

  beforeEach(() => {
    previousWebhookKey = process.env.TELETON_WEBHOOK_KEY;
    process.env.TELETON_WEBHOOK_KEY = WEBHOOK_TEST_KEY;
    db = createTestDb();
    app = fetchApp(new WebUIServer(buildDeps(db)));
  });

  afterEach(() => {
    resetWebhookDispatcherForTesting(db);
    resetEventBusForTesting(db);
    db.close();
    if (previousWebhookKey === undefined) {
      delete process.env.TELETON_WEBHOOK_KEY;
    } else {
      process.env.TELETON_WEBHOOK_KEY = previousWebhookKey;
    }
  });

  it("allows signed incoming webhooks without WebUI auth cookies or CSRF headers", async () => {
    const webhook = getWebhookDispatcher(db).createWebhook({
      url: "https://hooks.example.com/teleton",
      events: ["external.other"],
      secret: "incoming-secret",
    });
    const raw = JSON.stringify({ type: "webhook.incoming", repository: "demo" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", "incoming-secret")
      .update(`inbound:${timestamp}.${raw}`)
      .digest("hex");

    const res = await app.request(`/api/webhooks/incoming/${webhook.id}`, {
      method: "POST",
      body: raw,
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": `sha256=${signature}`,
        "X-Webhook-Timestamp": timestamp,
      },
    });
    const json = await res.json();

    expect(res.status).toBe(202);
    expect(json.success).toBe(true);
    expect(json.data.type).toBe("webhook.incoming");
    expect(getEventBus(db).listEvents({ type: "webhook.incoming" }).total).toBe(1);
  });

  it("keeps invalid incoming webhook signatures rejected by the route verifier", async () => {
    const webhook = getWebhookDispatcher(db).createWebhook({
      url: "https://hooks.example.com/teleton",
      events: ["external.other"],
      secret: "incoming-secret",
    });

    const res = await app.request(`/api/webhooks/incoming/${webhook.id}`, {
      method: "POST",
      body: JSON.stringify({ type: "webhook.incoming" }),
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": "sha256=bad",
      },
    });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.success).toBe(false);
    expect(json.error).toMatch(/Invalid.*webhook signature/);
  });

  it("allows workflow webhook secrets without WebUI auth cookies or CSRF headers", async () => {
    new WorkflowStore(db).create({
      name: "Public webhook workflow",
      enabled: true,
      config: {
        trigger: { type: "webhook", secret: "workflow-secret" },
        actions: [],
      },
    });

    const res = await app.request("/api/workflows/webhook/workflow-secret", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
      headers: { "Content-Type": "application/json" },
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
  });

  it("keeps invalid workflow webhook secrets rejected by the route verifier", async () => {
    const res = await app.request("/api/workflows/webhook/missing-secret", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
      headers: { "Content-Type": "application/json" },
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
    expect(json.error).toBe("No workflow found for this webhook");
  });

  it("keeps normal mutating API routes protected by CSRF and WebUI auth", async () => {
    const missingCsrf = await app.request("/api/webhooks", {
      method: "POST",
      body: JSON.stringify({
        url: "https://hooks.example.com/teleton",
        events: ["webhook.incoming"],
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(missingCsrf.status).toBe(403);

    const csrfToken = extractCsrfCookie(await app.request("/api/webhooks"));
    const missingAuth = await app.request("/api/webhooks", {
      method: "POST",
      body: JSON.stringify({
        url: "https://hooks.example.com/teleton",
        events: ["webhook.incoming"],
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `${CSRF_COOKIE_NAME}=${csrfToken}`,
        [CSRF_HEADER_NAME]: csrfToken,
      },
    });

    expect(missingAuth.status).toBe(401);
  });
});
