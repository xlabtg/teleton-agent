---
title: "[AUDIT/V8] On-chain confirmation window (20 s) is shorter than the wallet message validity (about 60 s): a transfer reported as \"failed\" can still land, which leads to double payouts"
labels: ["bug", "audit-finding-v8", "medium", "v3.x", "financial-safety"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-010"
severity: "medium"
category: "financial-safety"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/749"
---

## Problem Description

```ts
await contract.sendTransfer({ seqno, secretKey, sendMode, messages }); // no `timeout`
...
const confirmed = await confirmWalletTx(client, contract.address, sinceLt); // gives up after 20 s
if (!confirmed) { if (broadcastError) throw broadcastError; return null; }
```
`@ton/ton` `WalletContractV5R1.createTransfer` sets `valid_until` to `now + 60` when no `timeout` is passed. A signed external message can therefore be accepted up to about 60 s after broadcast. Liteserver lag, masterchain delays or a slow toncenter index can push inclusion past 20 s. In that case:
- `sendTon` returns `null` and `sendWalletTx` may rethrow. `jetton_send` / `ton_send` report failure. `executeDeal` marks the deal `failed` (`executor.ts:257-262`) and the user is told nothing was sent.
- The tx-lock is released. If the LLM, the user or an admin retries after the first message lands (between seconds 20 and 60), the retry reads the new seqno and sends the funds a second time.

## Location

- `src/ton/confirm.ts:100-123` (`sendWalletTx` calls `contract.sendTransfer` without `timeout` at :110), `src/ton/confirm.ts:52-90` (`confirmWalletTx`), `src/constants/timeouts.ts:22` (`TON_CONFIRM_TIMEOUT_MS = 20_000`)
- used by `transfer.ts`, `sdk/ton.ts`, `jetton-send.ts`, `deals/executor.ts`

## How To Reproduce

Mock `client.getTransactions` to return the external-in tx only after 25 s and stub `sendTransfer` to succeed. `sendTon` returns `null`. A second `sendTon` call at 30 s builds seqno+1, so both transfers are effective.

**Verification evidence:** Read `confirm.ts` and `timeouts.ts`. No caller passes `timeout`: grepped `sendTransfer(` in src/ton and src/agent/tools. `createTransfer` in `sdk/ton.ts` does set `TX_VALID_UNTIL_SECONDS = 120`, but the broadcast paths do not. Not covered by #311/#335 (those added confirmation, not the validity-window mismatch). I could not run this: node_modules is not installed. The 60 s default is the documented `@ton/ton` V5R1 behaviour.

## Impact

False "failed" results while funds actually left the wallet, followed by duplicate transfers on retry. In deals, the deal is marked failed even though the payout was made.

## Proposed Fix

Pass an explicit `timeout: now + N` to `sendTransfer`. Make `TON_CONFIRM_TIMEOUT_MS` strictly greater than `N` plus a margin (for example `N = 45 s`, confirm for 75 s). If a timeout still happens, keep polling until `valid_until` has passed before returning "not sent", and report "unknown / pending" rather than failure.

## Regression Test

```ts
it("does not report failure while the signed message is still valid", async () => {
  vi.useFakeTimers();
  // getTransactions returns the external-in tx only after 25 s
  const p = sendWalletTx(client, contract, {...});
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(p).resolves.toMatchObject({ hash: expect.any(String) });
  expect(sendTransferMock.mock.calls[0][0].timeout).toBeLessThanOrEqual(nowSec + TON_CONFIRM_TIMEOUT_MS/1000);
});
```

## Acceptance Criteria

- [ ] Every wallet transfer carries an explicit `timeout`.
- [ ] `confirmWalletTx` never gives up before that `valid_until` has passed.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-010`
- Audit track notes: `experiments/audit8/ton.md` (finding 3)
