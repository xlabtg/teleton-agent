import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { AuditTrailService } from "../../src/services/audit-trail.js";

describe("audit8 webui-2: pruneBefore breaks verifyIntegrity", () => {
  it("reports tamper after legitimate prune", () => {
    const svc = new AuditTrailService(new Database(":memory:"));
    svc.recordEvent({ eventType: "config.changed" as never, createdAt: 1000 });
    svc.recordEvent({ eventType: "config.changed" as never, createdAt: 2000 });
    svc.recordEvent({ eventType: "config.changed" as never, createdAt: 3000 });
    expect(svc.verifyIntegrity().valid).toBe(true);
    expect(svc.pruneBefore(1500)).toBe(1);
    const r = svc.verifyIntegrity();
    expect(r.valid).toBe(false); // BUG: false tamper alert
  });
});
