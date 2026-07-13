---
title: "[AUDIT/V7] withTxLock releases the wallet mutex on its 60s timeout while the transaction may still be in-flight (seqno reuse / double-send)"
labels: ["bug", "audit-finding-v7", "high", "v3.0-blocker", "financial-safety"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-004"
severity: "high"
category: "financial-safety"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/694"
---

## Problem Description

`withTxLock` serializes the `seqno read → sendTransfer` sequence so two concurrent
callers cannot obtain the same seqno. It guards each critical section with a 60 s
timeout implemented via `Promise.race`:

```ts
// src/ton/tx-lock.ts:8-27
const TX_LOCK_TIMEOUT_MS = 60_000;
export function withTxLock<T>(fn: () => Promise<T>): Promise<T> {
  const guarded = () => {
    let timerId;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => reject(new Error("TON tx-lock timeout (60s)")), TX_LOCK_TIMEOUT_MS);
    });
    return Promise.race([fn(), timeoutPromise]).finally(() => clearTimeout(timerId));
  };
  const execute = pending.then(guarded, guarded);
  pending = execute.then(() => {}, () => {});   // <-- next waiter unblocks when the RACE settles
  return execute;
}
```

`pending` (the chain the next caller awaits) is advanced when the **race** settles
— i.e. as soon as the 60 s timeout fires — **not** when `fn()` actually finishes.
`Promise.race` does not cancel the losing promise, so when a slow
`sendTransfer`/confirm exceeds 60 s the timeout rejects, the mutex is released, and
`fn()` **keeps running in the background**. The next queued transaction then reads
the wallet seqno while the previous transfer is still in flight → **both use the
same seqno**. On TON, one is dropped or (worse, for idempotency-sensitive deal
sends) the same intent is effectively re-sent.

60 s is realistically shorter than a worst-case send-plus-confirm under network
/RPC latency, so this is reachable in normal operation, not just adversarially.

## Location

- `src/ton/tx-lock.ts:8-27` — timeout releases the lock while `fn()` may still run.

## How To Reproduce

1. Wrap a `fn` that resolves after ~65 s (simulating a slow send/confirm) in
   `withTxLock`, and immediately queue a second `withTxLock(fn2)`.
2. At t≈60 s the first call rejects with "tx-lock timeout"; `fn2` starts and reads
   seqno **before** `fn`'s transfer settled → same seqno observed by both.

## Impact

Loss of the mutual-exclusion guarantee the lock exists to provide: seqno reuse,
dropped transactions, and potential double-execution of financial actions (TON
send, jetton send, deal settlement) precisely in the slow-network conditions where
correctness matters most.

## Proposed Fix

- Advance `pending` off the **actual completion of `fn()`**, not off the race, so
  the next waiter never starts until the previous critical section truly finishes:
  keep the timeout only to reject the *caller's* promise while still chaining the
  lock release to `fn()`'s settlement.
- Alternatively, make `fn()` genuinely cancellable (abort the send + confirm) and
  only release the lock after the abort completes.
- Reassess whether a fixed 60 s cap is appropriate for confirm-inclusive flows.

## Regression Test

```typescript
it("does not release the tx lock until fn() actually settles, even past the timeout", async () => {
  let secondStartedBeforeFirstDone = false;
  let firstDone = false;
  const first = withTxLock(async () => { await delay(TX_LOCK_TIMEOUT_MS + 50); firstDone = true; });
  const second = withTxLock(async () => { secondStartedBeforeFirstDone = !firstDone; });
  await Promise.allSettled([first, second]);
  expect(secondStartedBeforeFirstDone).toBe(false);
});
```

## Acceptance Criteria

- [ ] A queued transaction never begins while the previous critical section is
      still executing, regardless of the timeout.
- [ ] The timeout still surfaces an error to the *stuck caller* without breaking
      mutual exclusion.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-004`
- Modules: `src/ton/tx-lock.ts`
