---
title: "[AUDIT/V7] jetton_send uses `decimals || 9`, sending a 10^9×-wrong amount for 0-decimal jettons"
labels: ["bug", "audit-finding-v7", "medium", "financial-safety"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-010"
severity: "medium"
category: "financial-safety"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/700"
---

## Problem Description

`jetton_send` derives the jetton's decimals with a logical-OR default:

```ts
// src/agent/tools/ton/jetton-send.ts:104-113
const decimals = jettonBalance.jetton.decimals || 9;
...
const amountInUnits = toUnits(amount, decimals);
...
const balanceHuman = Number(currentBalance) / 10 ** decimals;
```

For a jetton with **0 decimals**, `0 || 9` evaluates to `9` (because `0` is
falsy). The transfer amount is then scaled by `10^9` instead of `10^0`, and the
human-readable balance check divides by `10^9`. A user asking to send `5` units of
a 0-decimal jetton would attempt to send `5_000_000_000` base units — a
catastrophic over-send — and the balance guard is computed on the wrong scale too.

Contrast the DeDust helper, which correctly uses nullish coalescing
(`asset?.decimals ?? 9`), preserving `0`.

## Location

- `src/agent/tools/ton/jetton-send.ts:104` — `const decimals =
  jettonBalance.jetton.decimals || 9;` (should be `?? 9`).

## How To Reproduce

1. Hold a jetton whose metadata reports `decimals = 0`.
2. Call `jetton_send` for `amount = 5`.
3. `decimals` becomes `9`; `toUnits(5, 9)` = `5_000_000_000` base units instead of
   `5`, and `balanceHuman` is off by `10^9`.

## Impact

Financial: for any 0-decimal jetton the sent amount and the balance check are wrong
by nine orders of magnitude — either a massive over-send or a spurious
insufficient-balance rejection. 0-decimal jettons exist on TON, so this is a real
correctness/safety hazard for a wallet-capable agent.

## Proposed Fix

Use nullish coalescing: `const decimals = jettonBalance.jetton.decimals ?? 9;` and
audit the codebase for other `decimals || N` occurrences. Prefer requiring explicit
decimals metadata for financial transfers rather than a silent default.

## Regression Test

```typescript
it("respects 0-decimal jettons", () => {
  const units = computeUnits({ decimals: 0 }, 5);
  expect(units).toBe(5n);                 // not 5_000_000_000n
});
```

## Acceptance Criteria

- [ ] A jetton reporting `decimals = 0` is scaled by `10^0`.
- [ ] The balance check uses the same (correct) scale.
- [ ] No remaining `decimals || N` on financial paths.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-010`
- Modules: `src/agent/tools/ton/jetton-send.ts`
