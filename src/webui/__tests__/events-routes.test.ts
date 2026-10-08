import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import type { WebUIServerDeps } from "../types.js";
import { getEventBus, resetEventBusForTesting } from "../../services/event-bus.js";
import { resetWebhookDispatcherForTesting } from "../../services/webhook-dispatcher.js";
import { createEventsRoutes } from "../routes/events.js";
import { createWebhooksRoutes } from "../routes/webhooks.js";

const WEBHOOK_TEST_KEY = "22".repeat(32);

function buildApp(db: Database.Database) {
  const deps = { memory: { db } } as unknown as WebUIServerDeps;
  const app = new Hono();
  app.route("/events", createEventsRoutes(deps));
  app.route("/webhooks", createWebhooksRoutes(deps));
  return app;
}

describe("events and webhooks routes", () => {
  let db: Database.Database;
  let app: ReturnType<typeof buildApp>;
  let previousWebhookKey: string | undefined;

  beforeEach(() => {
    previousWebhookKey = process.env.TELETON_WEBHOOK_KEY;
    process.env.TELETON_WEBHOOK_KEY = WEBHOOK_TEST_KEY;
    db = new Database(":memory:");
    app = buildApp(db);
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

  it("lists logged events with type filters", async () => {
    await getEventBus(db).publish({
      type: "agent.message.received",
      source: "test",
      payload: { text: "hello" },
    });
    await getEventBus(db).publish({
      type: "tool.failed",
      source: "test",
      payload: { toolName: "bad" },
    });

    const res = await app.request("/events?type=tool.failed");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.events).toHaveLength(1);
    expect(json.data.events[0].type).toBe("tool.failed");
  });

  it("creates and lists webhook registrations without returning the raw secret", async () => {
    const createRes = await app.request("/webhooks", {
      method: "POST",
      body: JSON.stringify({
        url: "https://hooks.example.com/teleton",
        events: ["agent.message.received"],
        secret: "top-secret",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const created = await createRes.json();

    expect(createRes.status).toBe(201);
    expect(created.success).toBe(true);
    expect(created.data.secret).toBeUndefined();

    const listRes = await app.request("/webhooks");
    const listed = await listRes.json();
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].secret).toBeUndefined();
  });

  it("verifies incoming webhook signatures and maps payloads to internal events", async () => {
    const createRes = await app.request("/webhooks", {
      method: "POST",
      body: JSON.stringify({
        url: "https://hooks.example.com/teleton",
        events: ["webhook.incoming"],
        secret: "incoming-secret",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const created = await createRes.json();
    const raw = JSON.stringify({ type: "webhook.incoming", repository: "demo" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", "incoming-secret")
      .update(`inbound:${timestamp}.${raw}`)
      .digest("hex");

    const incomingRes = await app.request(`/webhooks/incoming/${created.data.id}`, {
      method: "POST",
      body: raw,
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": `sha256=${signature}`,
        "X-Webhook-Timestamp": timestamp,
      },
    });
    const incoming = await incomingRes.json();

    expect(incomingRes.status).toBe(202);
    expect(incoming.success).toBe(true);
    expect(incoming.data.type).toBe("webhook.incoming");

    const eventsRes = await app.request("/events?type=webhook.incoming");
    const events = await eventsRes.json();
    expect(events.data.events).toHaveLength(1);
    expect(events.data.events[0].payload.repository).toBe("demo");
  });
});
