---
title: "[AUDIT/V8] `AuditTrailService.pruneBefore` makes `verifyIntegrity` report tampering on an untampered log"
labels: ["bug", "audit-finding-v8", "medium", "v3.x", "data-integrity"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-015"
severity: "medium"
category: "data-integrity"
github-issue: "TBD"
---

## Problem Description

```ts
pruneBefore(cutoffUnix: number): number {
  const result = this.db.prepare(`DELETE FROM audit_events WHERE created_at < ?`).run(cutoffUnix);
```
After pruning, `verifyIntegrity()` seeds the chain from `SELECT checksum ... WHERE sequence < first`. That row has been deleted, so the seed is `null`. The first surviving row still stores its predecessor's checksum in `previous_checksum`, so the check fails:

```ts
if (row.previous_checksum !== previousChecksum) { result.valid = false; ... "Previous checksum mismatch"
```

`exportEvents` (line 393) embeds this result, so every export after a prune is flagged as tampered. `pruneBefore` is a public API with no in-tree callers yet. Wiring up any retention job triggers the bug.

## Location

- src/services/audit-trail.ts:288-322, :446-449

## How To Reproduce

Record 3 events with createdAt 1000/2000/3000 and confirm `verifyIntegrity().valid === true`. Then call `pruneBefore(1500)` and `verifyIntegrity()`. The result is `valid === false`, with `brokenAtEventId` set to the first surviving event.

**Verification evidence:** Confirmed by reading the source (lines 294-322 and 446-449). A repro is written in experiments/audit8/repro-webui-2.test.ts. It could not be executed here because the better-sqlite3 native binding is not built in this environment (the "Could not locate the bindings file" error). The logic is deterministic: after the delete, the seed query returns undefined, so the seed is null, while the row's previous_checksum is not null.

## Impact

Applying a retention policy causes permanent false tamper alerts. Operators then cannot tell real tampering from pruning, which defeats the purpose of the audit log.

## Proposed Fix

In the same transaction as the delete, store an anchor (the last pruned `sequence` and `checksum`) in an `audit_meta` table. `verifyIntegrity` uses this anchor when no earlier row exists. Alternatively, when the first row checked is the oldest remaining row, accept its `previous_checksum` only if it matches the stored anchor.

## Regression Test

```ts
const svc = new AuditTrailService(new Database(":memory:"));
for (const t of [1000, 2000, 3000]) svc.recordEvent({ eventType: "config.changed", createdAt: t });
svc.pruneBefore(1500);
expect(svc.verifyIntegrity().valid).toBe(true);
db.prepare("UPDATE audit_events SET payload='{\"x\":1}' WHERE sequence=2").run();
expect(svc.verifyIntegrity().valid).toBe(false);
```

## Acceptance Criteria

- [ ] After a prune, verification still passes on an untouched log, and real tampering of the surviving rows (including the first one) is still detected.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-015`
- Audit track notes: `experiments/audit8/webui.md` (finding 4)
- Repro: `experiments/audit8/repro-webui-2.test.ts`
