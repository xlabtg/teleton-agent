---
title: "[AUDIT/V7] Autonomous policy engine never enforces the daily TON budget (only per-task), so cumulative spend is uncapped"
labels: ["bug", "audit-finding-v7", "high", "v3.0-blocker", "financial-safety"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-003"
severity: "high"
category: "financial-safety"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/693"
---

## Problem Description

`PolicyConfig.tonSpending` advertises a **`daily`** budget alongside `perTask`:

```ts
// src/autonomous/policy-engine.ts:17-22, 39-43
tonSpending: {
  perTask: number;
  daily: number;                 // <-- declared
  requireConfirmationAbove: number;
};
// DEFAULT_POLICY_CONFIG.tonSpending = { perTask: 0.1, daily: 0.5, requireConfirmationAbove: 0.05 }
```

But the enforcement path only ever checks **per-task**:

```ts
// src/autonomous/policy-engine.ts:302-320
} else if (tonSpend.kind === "amount" && tonSpend.amount > 0) {
  const budgetTON = constraints.budgetTON ?? this.config.tonSpending.perTask;
  if (tonSpend.amount > budgetTON) { /* budget_exceeded */ }
  ...
  if (tonSpend.amount > this.config.tonSpending.requireConfirmationAbove) { /* ton_confirmation */ }
}
```

`this.config.tonSpending.daily` is **read nowhere** in the engine (a repo-wide
grep finds it only in the config default and the unit test). There is **no
cumulative spend tracking** (no `spentToday`/`dailySpent` state), so an autonomous
agent can execute an unbounded number of tasks each at or below `perTask` (0.1
TON) and blow far past the intended `daily` ceiling (0.5 TON) with no block.

## Location

- `src/autonomous/policy-engine.ts:302-320` — only `perTask` / `budgetTON` is
  compared; `daily` is not.
- `src/autonomous/policy-engine.ts:17-22, 39-43` — `daily` declared and defaulted
  to `0.5`.
- (No accumulator anywhere: grep for `spentToday|dailySpent|cumulative|totalSpent`
  returns nothing in the engine.)

## How To Reproduce

1. Use `DEFAULT_POLICY_CONFIG` (`perTask: 0.1`, `daily: 0.5`).
2. Drive the autonomous loop through 10 tasks each spending `0.1` TON.
3. Every task passes the budget check; total spend = `1.0` TON — **2× the daily
   cap** — with no `budget_exceeded` for exceeding `daily`.

## Impact

The advertised daily spending guardrail is a no-op. In an autonomous / long-running
session a mis-behaving plan (or a prompt-injected one) can drain the wallet in
`perTask`-sized increments while every individual action looks compliant. This is
a financial-safety control that silently does not exist.

## Proposed Fix

- Track cumulative TON spend per UTC day (persisted, keyed by wallet) and, in the
  budget branch, reject when `spentToday + tonSpend.amount > tonSpending.daily`
  with a distinct `budget_exceeded` reason (daily vs per-task).
- Record actual settled spend (not just requested amount) after each successful TON
  action so the accumulator reflects reality.

## Regression Test

```typescript
it("blocks once cumulative daily TON spend would exceed the daily cap", () => {
  const engine = new PolicyEngine({ tonSpending: { perTask: 0.1, daily: 0.25, requireConfirmationAbove: 1 } });
  engine.recordSpend(0.1); engine.recordSpend(0.1);            // 0.2 spent today
  const decision = engine.evaluate({ toolName: "ton_send", params: { amount: 0.1 } });
  expect(decision.type).toBe("budget_exceeded");               // 0.2 + 0.1 > 0.25
});
```

## Acceptance Criteria

- [ ] The engine tracks cumulative per-day TON spend.
- [ ] An action is blocked when it would push the day's total over `tonSpending.daily`.
- [ ] Per-task and daily rejections are distinguishable.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-003`
- Modules: `src/autonomous/policy-engine.ts`
