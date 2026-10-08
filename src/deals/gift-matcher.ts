import type Database from "better-sqlite3";
/**
 * Gift payment matcher - pure logic for deciding whether a received gift
 * settles a deal's expected gift payment.
 *
 * Timestamp convention: all comparisons here are performed in milliseconds.
 * `ReceivedGift.receivedAt` is normalized to ms by the gift detector, and
 * `Deal.created_at` (epoch seconds) is converted to ms at the comparison point.
 */

import type { Deal, ReceivedGift } from "./types.js";

export interface GiftPaymentMatch {
  verified: boolean;
  gift?: ReceivedGift;
}

/**
 * Find a received gift that satisfies the deal's expected gift payment:
 * - same gift slug as the deal expects,
 * - sent by the deal's buyer (fromUserId === user_telegram_id),
 * - received at or after the deal was created.
 */
export function verifyGiftPayment(
  deal: Pick<Deal, "user_gives_gift_slug" | "user_telegram_id" | "created_at">,
  gifts: ReceivedGift[],
  isUsed: (msgId: string) => boolean = () => false
): GiftPaymentMatch {
  const gift = gifts.find(
    (g) =>
      !isUsed(g.msgId) &&
      g.slug === deal.user_gives_gift_slug &&
      g.fromUserId === deal.user_telegram_id &&
      g.receivedAt >= deal.created_at * 1000 // created_at is epoch seconds → ms
  );

  return { verified: Boolean(gift), gift };
}

export function isGiftPaymentUsed(db: Database.Database, msgId: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM deals WHERE user_payment_gift_msgid = ? LIMIT 1").get(msgId)
  );
}

/** Atomic payment reservation shared by the interactive tool and background poller. */
export function claimGiftPayment(
  db: Database.Database,
  dealId: string,
  msgId: string,
  expectedStatus: "accepted" | "payment_claimed"
): boolean {
  return (
    db
      .prepare(
        `UPDATE deals SET status = 'verified', user_payment_gift_msgid = ?, user_payment_verified_at = unixepoch()
    WHERE id = ? AND status = ? AND NOT EXISTS (SELECT 1 FROM deals WHERE user_payment_gift_msgid = ?)`
      )
      .run(msgId, dealId, expectedStatus, msgId).changes === 1
  );
}
