import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import type { WebUIServerDeps } from "../types.js";

const streamHarness = vi.hoisted(() => ({
  error: undefined as unknown,
  stream: undefined as unknown,
}));

vi.mock("hono/streaming", () => ({
  streamSSE: vi.fn(
    async (_context: unknown, callback: (stream: unknown) => Promise<void>): Promise<Response> => {
      streamHarness.error = undefined;
      try {
        await callback(streamHarness.stream);
      } catch (error) {
        streamHarness.error = error;
      }

      return new Response("", {
        headers: { "Content-Type": "text/event-stream" },
        status: 200,
      });
    }
  ),
}));

import { auditTrailBus } from "../../services/audit-trail.js";
import { notificationBus } from "../../services/notifications.js";
import { AgentLifecycle } from "../../agent/lifecycle.js";
import { createLifecycleSSE } from "../lifecycle-sse.js";
import { createAuditRoutes } from "../routes/audit.js";
import { createNotificationsRoutes } from "../routes/notifications.js";

function createFailingHeartbeatStream() {
  return {
    onAbort: vi.fn(),
    sleep: vi.fn(async () => {}),
    writeSSE: vi.fn(async (payload: { event?: string }) => {
      if (payload.event === "ping") {
        throw new Error("simulated stream write failure");
      }
    }),
  };
}

function buildNotificationsApp(db: Database.Database) {
  const deps = { memory: { db } } as unknown as WebUIServerDeps;
  const app = new Hono();
  app.route("/notifications", createNotificationsRoutes(deps));
  return app;
}

function buildAuditApp(db: Database.Database) {
  const deps = { memory: { db } } as unknown as WebUIServerDeps;
  const app = new Hono();
  app.route("/audit", createAuditRoutes(deps));
  return app;
}

describe("SSE listener cleanup", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    notificationBus.removeAllListeners("update");
    auditTrailBus.removeAllListeners("event");
  });

  afterEach(() => {
    notificationBus.removeAllListeners("update");
    auditTrailBus.removeAllListeners("event");
    db.close();
  });

  it("removes notification listeners when a heartbeat write fails", async () => {
    const app = buildNotificationsApp(db);
    const before = notificationBus.listenerCount("update");
    streamHarness.stream = createFailingHeartbeatStream();

    const res = await app.request("/notifications/stream");

    expect(res.status).toBe(200);
    expect(streamHarness.error).toBeInstanceOf(Error);
    expect(notificationBus.listenerCount("update")).toBe(before);
  });

  it("removes audit listeners when a heartbeat write fails", async () => {
    const app = buildAuditApp(db);
    const before = auditTrailBus.listenerCount("event");
    streamHarness.stream = createFailingHeartbeatStream();

    const res = await app.request("/audit/stream");

    expect(res.status).toBe(200);
    expect(streamHarness.error).toBeInstanceOf(Error);
    expect(auditTrailBus.listenerCount("event")).toBe(before);
  });

  it("removes lifecycle listeners when a heartbeat write fails", async () => {
    const lifecycle = new AgentLifecycle();
    const before = lifecycle.listenerCount("stateChange");
    streamHarness.stream = createFailingHeartbeatStream();

    const res = await createLifecycleSSE({} as never, lifecycle);

    expect(res.status).toBe(200);
    expect(streamHarness.error).toBeInstanceOf(Error);
    expect(lifecycle.listenerCount("stateChange")).toBe(before);
  });
});
