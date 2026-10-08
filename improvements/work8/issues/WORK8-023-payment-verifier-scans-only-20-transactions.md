---
title: "[AUDIT/V8] Payment verification scans only the latest 20 wallet transactions: cheap dust spam (or normal traffic) hides a real payment and the deal expires"
labels: ["bug", "audit-finding-v8", "low", "v3.x", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-023"
severity: "low"
category: "reliability"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/762"
---

## Problem Description

Only one page of 20 transactions is checked, with no pagination down to `requestTime`. Outgoing transactions, gas refunds, jetton notifications and dust deposits all count toward the 20.

## Location

- `src/ton/payment-verifier.ts:78` (`getTransactions(botAddress, { limit: 20 })`), `src/sdk/ton.ts:383` `verifyPayment` (`this.getTransactions(address, 20)`)
- deal expiry is 120 s (`src/deals/config.ts:12`)

## How To Reproduce

A buyer pays deal A. A third party, or the agent's own traffic, then adds more than 20 transactions within the 10-minute window (for example 21 transfers of 1 nanoTON, costing about 0.06 TON in fees). `deal_verify_payment` returns "Payment not found" and the deal expires. The buyer's TON stays with the bot and the deal is never executed.

**Verification evidence:** Read both verifiers. Neither paginates. No prior issue about this (searched prior titles for "limit"/"spam"/"pagination").

## Impact

A paying user gets no service and needs manual refund handling. Deals can be griefed cheaply.

## Proposed Fix

Paginate with `lt`/`hash` until `tx.now * 1000 < requestTime`, with a hard cap (for example 200 txs). Optionally filter by comment server-side through TonAPI.

## Regression Test

Mock `getTransactions` to return 20 dust txs on page 1 and the matching payment on page 2. Expect `verified: true`.

## Acceptance Criteria

- [ ] - A matching payment inside the time window is found no matter how many other transactions arrived after it, up to the documented cap.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-023`
- Audit track notes: `experiments/audit8/ton.md` (finding 5)
