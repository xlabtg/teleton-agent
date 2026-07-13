---
title: "[AUDIT/V7] gocoon data directory holding wallet.json is created without 0o700, leaving wallet key material world-traversable"
labels: ["bug", "audit-finding-v7", "medium", "security"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-022"
severity: "medium"
category: "security"
github-issue: ""
---

## Problem Description

The gocoon data directory stores the on-chain **wallet** (`wallet.json`) and client
config, yet it is created with no explicit mode:

```ts
// src/gocoon/paths.ts:15-16
export const gocoonDataDir = (): string => join(TELETON_ROOT, "gocoon");
export const walletPath   = (): string => join(gocoonDataDir(), "wallet.json");

// src/gocoon/cli.ts:84
mkdirSync(gocoonDataDir(), { recursive: true });   // no { mode: 0o700 }
```

Under a default umask (`022`) the directory is created `0o755` — traversable by any
local user, exposing `wallet.json` (private-key material) and `ton-config.json`.
This is the same hardening gap addressed for other sensitive dirs in WORK6-007, but
the gocoon wallet directory was not covered.

## Location

- `src/gocoon/cli.ts:84` — `mkdirSync(gocoonDataDir(), { recursive: true })` with no
  restrictive mode.
- `src/gocoon/paths.ts:16` — `wallet.json` lives inside that directory.
- (Also verify the gocoon binary itself writes `wallet.json` with `0o600`.)

## How To Reproduce

1. Run gocoon init so the data dir + `wallet.json` are created.
2. `stat` the directory → `0o755` (world-traversable), not `0o700`.

## Impact

Wallet private-key material and TON config are reachable by other local users on a
shared host, risking theft of funds controlled by the agent's wallet.

## Proposed Fix

Create the gocoon data directory with `{ recursive: true, mode: 0o700 }` (and
`chmod(gocoonDataDir(), 0o700)` after creation to be robust when intermediate dirs
already existed). Ensure `wallet.json` is `0o600`.

## Regression Test

```typescript
it("creates the gocoon data dir 0o700", () => {
  ensureGocoonDataDir();
  expect(statSync(gocoonDataDir()).mode & 0o077).toBe(0);
});
```

## Acceptance Criteria

- [ ] The gocoon data directory is `0o700`.
- [ ] `wallet.json` is not world/group-readable.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-022`
- Modules: `src/gocoon/cli.ts`, `src/gocoon/paths.ts`
- Related: WORK6-006, WORK6-007 (permission hardening).
