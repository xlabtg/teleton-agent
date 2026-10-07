---
title: "[AUDIT/V8] One received gift can verify any number of deals (no gift msgId reuse protection), so the agent pays out more than once"
labels: ["bug", "audit-finding-v8", "high", "v3.0-blocker", "financial-safety"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-001"
severity: "high"
category: "financial-safety"
github-issue: "TBD"
---

## Problem Description

TON payments are de-duplicated through `used_transactions` (INSERT OR IGNORE on the tx hash). Gift payments have no equivalent. The matcher accepts any gift with the right slug and sender that arrived after the deal was created:

```ts
const gift = gifts.find(
  (g) =>
    g.slug === deal.user_gives_gift_slug &&
    g.fromUserId === deal.user_telegram_id &&
    g.receivedAt >= deal.created_at * 1000
);
```

`verify-payment.ts` creates a new `GiftDetector()` on every call, so its `seenGifts` cache is always empty and every gift in the inbox counts as "new". The poller (`verification-poller.ts:221`) works the same way. Neither path checks whether another deal already stored that `msgId` in `user_payment_gift_msgid`, and the column has no UNIQUE index. Nothing limits how many open deals a user can have (`propose.ts` has no such check).

## Location

- `src/deals/gift-matcher.ts:23-35`, `src/agent/tools/deals/verify-payment.ts:150-208`, `src/bot/services/verification-poller.ts:218-282`, `src/deals/db.ts:42` (no UNIQUE on `user_payment_gift_msgid`)

## How To Reproduce

1. User 42 opens two deals A and B, each "user gives gift `plush-pepe`, agent gives X TON", and accepts both.
2. User sends one `plush-pepe` gift.
3. Call `deal_verify_payment` for A, then for B (or let the poller handle both). Both match msgId 777, both move to `verified`, and `executeDeal` pays out twice.

Repro (pure logic): `node experiments/audit8/repro-ton-gift-reuse.mts`
```
deal A: 777
deal B: 777
```

**Verification evidence:** - Read both verification paths and the deals schema. The only indexes on `deals` are status, user, chat, inline_msg, payment_claimed and expires. None is unique on the gift msgid.
- The repro above shows both deals matching the same gift.

## Impact

The agent pays out N times for one gift. Anyone can do this with N parallel deals.

## Proposed Fix

- Add `CREATE UNIQUE INDEX ... ON deals(user_payment_gift_msgid) WHERE user_payment_gift_msgid IS NOT NULL`, or insert `gift:<msgId>` into a used-payments table inside the same transaction as the `accepted→verified` UPDATE.
- When matching, skip gifts whose msgId is already linked to another deal: `NOT EXISTS (SELECT 1 FROM deals WHERE user_payment_gift_msgid = ?)`.
- Apply the same check in both `verify-payment.ts` and `verification-poller.ts`.

## Regression Test

```ts
it("does not let one gift settle two deals", async () => {
  // seed deals A and B (accepted, same user and slug), mock get_my_gifts -> [{msgId:"777",...}]
  expect((await dealVerifyPaymentExecutor({dealId:"A"}, ctx)).success).toBe(true);
  expect((await dealVerifyPaymentExecutor({dealId:"B"}, ctx)).success).toBe(false);
  expect(sendTonMock).toHaveBeenCalledTimes(1);
});
```

## Acceptance Criteria

- [ ] A gift msgId can move at most one deal to `verified`, in both the tool path and the poller path.
- [ ] The DB rejects a second deal row with the same `user_payment_gift_msgid`.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-001`
- Audit track notes: `experiments/audit8/ton.md` (finding 1)
- Repro: `experiments/audit8/repro-ton-gift-reuse.mts`
