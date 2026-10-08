import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { AuditTrailService } from "../audit-trail.js";

describe("AuditTrailService", () => {
  let db: InstanceType<typeof Database>;
  let service: AuditTrailService;

  beforeEach(() => {
    db = new Database(":memory:");
    service = new AuditTrailService(db);
  });

  afterEach(() => {
    db.close();
  });

  it("preserves integrity and detects first-row tampering after pruning (#754)", () => {
    db.pragma("foreign_keys = ON");
    const first = service.recordEvent({ eventType: "config.changed", createdAt: 1000 });
    service.recordEvent({ eventType: "config.changed", createdAt: 2000, parentEventId: first.id });
    service.recordEvent({ eventType: "config.changed", createdAt: 3000 });
    expect(service.pruneBefore(1500)).toBe(1);
    expect(service.verifyIntegrity().valid).toBe(true);
    db.prepare("UPDATE audit_events SET payload = '{}' || ' ' WHERE sequence = 2").run();
    expect(service.verifyIntegrity().valid).toBe(false);
  });
  it("continues the chain after pruning everything (#754)", () => {
    service.recordEvent({ eventType: "config.changed", createdAt: 1000 });
    service.pruneBefore(1500);
    expect(service.recordEvent({ eventType: "config.changed", createdAt: 2000 }).sequence).toBe(2);
    expect(service.verifyIntegrity().valid).toBe(true);
  });
  it("records tamper-evident events with parent links", () => {
    const root = service.recordEvent({
      eventType: "session.lifecycle",
      actor: "agent",
      sessionId: "s1",
      payload: { phase: "start" },
    });
    const child = service.recordEvent({
      eventType: "agent.decision",
      actor: "agent",
      sessionId: "s1",
      parentEventId: root.id,
      payload: { decision: "select_tools", tools: ["web_fetch"] },
    });

    expect(root.sequence).toBe(1);
    expect(child.sequence).toBe(2);
    expect(child.parent_event_id).toBe(root.id);
    expect(child.previous_checksum).toBe(root.checksum);

    const verification = service.verifyIntegrity();
    expect(verification.valid).toBe(true);
    expect(verification.checked).toBe(2);
  });

  it("detects payload tampering", () => {
    const event = service.recordEvent({
      eventType: "tool.result",
      actor: "agent",
      payload: { toolName: "exec_run", success: true },
    });

    db.prepare("UPDATE audit_events SET payload = ? WHERE id = ?").run(
      JSON.stringify({ toolName: "exec_run", success: false }),
      event.id
    );

    const verification = service.verifyIntegrity();
    expect(verification.valid).toBe(false);
    expect(verification.brokenAtEventId).toBe(event.id);
    expect(verification.errors[0]).toContain("Checksum mismatch");
  });

  it("lists events with filters and pagination", () => {
    service.recordEvent({
      eventType: "llm.request",
      actor: "agent",
      sessionId: "s1",
      payload: { model: "a" },
    });
    service.recordEvent({
      eventType: "tool.invoke",
      actor: "agent",
      sessionId: "s2",
      payload: { toolName: "web_fetch" },
    });

    const page = service.listEvents({ eventType: "tool.invoke", page: 1, limit: 10 });

    expect(page.total).toBe(1);
    expect(page.entries[0].event_type).toBe("tool.invoke");
    expect(page.entries[0].session_id).toBe("s2");
  });

  it("reconstructs a decision chain from parent_event_id", () => {
    const root = service.recordEvent({
      eventType: "session.lifecycle",
      actor: "agent",
      sessionId: "s1",
      payload: { phase: "start" },
    });
    const decision = service.recordEvent({
      eventType: "agent.decision",
      actor: "agent",
      sessionId: "s1",
      parentEventId: root.id,
      payload: { decision: "invoke_tool" },
    });
    const result = service.recordEvent({
      eventType: "tool.result",
      actor: "agent",
      sessionId: "s1",
      parentEventId: decision.id,
      payload: { success: true },
    });

    const chain = service.getDecisionChain(result.id);

    expect(chain.events.map((event) => event.id)).toEqual([root.id, decision.id, result.id]);
  });

  it("generates tool usage reports from audit events", () => {
    service.recordEvent({
      eventType: "tool.result",
      actor: "agent",
      payload: { toolName: "web_fetch", success: true, durationMs: 50 },
    });
    service.recordEvent({
      eventType: "tool.result",
      actor: "agent",
      payload: { toolName: "web_fetch", success: false, durationMs: 150 },
    });

    const report = service.generateReport("tool_usage", { periodHours: 24 });

    expect(report.type).toBe("tool_usage");
    expect(report.rows).toEqual([
      expect.objectContaining({
        tool: "web_fetch",
        count: 2,
        successCount: 1,
        failureCount: 1,
        avgDurationMs: 100,
      }),
    ]);
  });

  it("exports signed JSON bundles", () => {
    service.recordEvent({
      eventType: "user.action",
      actor: "webui",
      payload: { method: "PUT", path: "/api/config" },
    });

    const exported = service.exportEvents({ format: "json" });
    const parsed = JSON.parse(exported.body) as {
      events: unknown[];
      verification: { valid: boolean };
      signature: { algorithm: string; value: string };
    };

    expect(exported.contentType).toContain("application/json");
    expect(parsed.events.length).toBe(1);
    expect(parsed.verification.valid).toBe(true);
    expect(parsed.signature.algorithm).toBe("sha256");
    expect(parsed.signature.value).toMatch(/^[a-f0-9]{64}$/);
  });

  it("exports every matching event instead of the paginated preview", () => {
    for (let index = 0; index < 205; index++) {
      service.recordEvent({
        eventType: "user.action",
        actor: "webui",
        payload: { index },
      });
    }

    const exported = service.exportEvents({ format: "json" });
    const parsed = JSON.parse(exported.body) as { events: unknown[] };

    expect(parsed.events.length).toBe(205);
  });
});
