import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { loadDealForActor } from "./load-deal.js";
import { verifyPayment } from "../../../ton/payment-verifier.js";
import { GiftDetector } from "../../../deals/gift-detector.js";
import {
  verifyGiftPayment,
  isGiftPaymentUsed,
  claimGiftPayment,
} from "../../../deals/gift-matcher.js";
import { getWalletAddress } from "../../../ton/wallet-service.js";
import { autoExecuteAfterVerification } from "../../../deals/executor.js";
import { getErrorMessage } from "../../../utils/errors.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("Tools");

interface DealVerifyPaymentParams {
  dealId: string;
}

export const dealVerifyPaymentTool: Tool = {
  name: "deal_verify_payment",
  description:
    "Verify payment/gift for an accepted deal. Checks blockchain (TON) or gift inbox. Auto-executes on success. Only for status='accepted'.",
  parameters: Type.Object({
    dealId: Type.String({ description: "Deal ID to verify payment for" }),
  }),
};

export const dealVerifyPaymentExecutor: ToolExecutor<DealVerifyPaymentParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    // Load deal + enforce owner/admin access
    const adminIds = context.config?.telegram.admin_ids ?? [];
    const loaded = loadDealForActor(
      context.db,
      params.dealId,
      context.senderId,
      adminIds,
      "verify payment for"
    );
    if (!loaded.ok) {
      return { success: false, error: loaded.error };
    }
    const deal = loaded.deal;

    // Check deal status
    if (deal.status !== "accepted") {
      return {
        success: false,
        error: `Deal #${params.dealId} has status '${deal.status}', not 'accepted'. Cannot verify.`,
      };
    }

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (now > deal.expires_at) {
      // Mark as expired (atomic: only if still accepted)
      const expireResult = context.db
        .prepare(`UPDATE deals SET status = 'expired' WHERE id = ? AND status = 'accepted'`)
        .run(params.dealId);
      if (expireResult.changes !== 1) {
        return {
          success: false,
          error: `Deal #${params.dealId} already transitioned by another process`,
        };
      }
      return {
        success: false,
        error: `Deal #${params.dealId} has expired (2 minutes elapsed)`,
      };
    }

    // Case 1: User gives TON → verify blockchain transaction
    if (deal.user_gives_type === "ton") {
      if (!deal.user_gives_ton_amount) {
        return {
          success: false,
          error: "Deal configuration error: user_gives_ton_amount is missing",
        };
      }

      // Get bot wallet address
      const botWallet = getWalletAddress();

      if (!botWallet) {
        return {
          success: false,
          error: "Wallet not initialized. Please run wallet setup first.",
        };
      }

      log.info(`[Deal] Verifying TON payment for deal #${params.dealId}...`);

      // Verify TON payment with dealId as memo
      const verification = await verifyPayment(context.db, {
        botWalletAddress: botWallet,
        betAmount: deal.user_gives_ton_amount,
        requestTime: deal.created_at * 1000, // Convert to milliseconds
        gameType: `deal:${params.dealId}`,
        userId: params.dealId, // Use dealId as memo identifier
      });

      if (!verification.verified) {
        return {
          success: false,
          error: `Payment verification failed: ${verification.error || "Transaction not found"}`,
        };
      }

      // Update deal: store TX hash, player wallet, mark as verified (atomic: only if still accepted)
      const verifyResult = context.db
        .prepare(
          `UPDATE deals SET
            status = 'verified',
            user_payment_tx_hash = ?,
            user_payment_wallet = ?,
            user_payment_verified_at = unixepoch()
          WHERE id = ? AND status = 'accepted'`
        )
        .run(verification.txHash, verification.playerWallet, params.dealId);

      if (verifyResult.changes !== 1) {
        return {
          success: false,
          error: `Deal #${params.dealId} already transitioned by another process (expected 'accepted')`,
        };
      }

      log.info(
        `[Deal] Payment verified for #${params.dealId} - TX: ${verification.txHash?.slice(0, 8)}...`
      );

      // Auto-execute deal (send agent's part)
      await autoExecuteAfterVerification(params.dealId, context.db, context.bridge);

      return {
        success: true,
        data: {
          dealId: params.dealId,
          verified: true,
          txHash: verification.txHash,
          amount: verification.amount,
          playerWallet: verification.playerWallet,
          date: verification.date,
          autoExecuted: true,
        },
      };
    }

    // Case 2: User gives gift → detect received gift
    if (deal.user_gives_type === "gift") {
      if (!deal.user_gives_gift_slug) {
        return {
          success: false,
          error: "Deal configuration error: user_gives_gift_slug is missing",
        };
      }

      log.info(`[Deal] Checking for gift receipt for deal #${params.dealId}...`);

      // Use GiftDetector to poll for new gifts — needs the agent's own Telegram ID
      const ownUserId = context.bridge.getOwnUserId();

      if (!ownUserId) {
        return {
          success: false,
          error: "Failed to get bot user info. Bot may not be authenticated.",
        };
      }

      const botUserId = Number(ownUserId);

      const giftDetector = new GiftDetector();
      const newGifts = await giftDetector.detectNewGifts(botUserId, context);

      // Find gift matching the expected slug from the deal's user.
      // Timestamps are compared in milliseconds (see verifyGiftPayment).
      const { gift: matchingGift } = verifyGiftPayment(deal, newGifts, (msgId) =>
        isGiftPaymentUsed(context.db, msgId)
      );

      if (!matchingGift) {
        return {
          success: false,
          error: `Gift not received yet. Expected: ${deal.user_gives_gift_slug} from user ${deal.user_telegram_id}. Please ensure user has sent the gift.`,
        };
      }

      // Update deal: store gift msgId, mark as verified (atomic: only if still accepted)
      const claimed = claimGiftPayment(context.db, params.dealId, matchingGift.msgId, "accepted");

      if (!claimed) {
        return {
          success: false,
          error: `Deal #${params.dealId} already transitioned by another process (expected 'accepted')`,
        };
      }

      log.info(`[Deal] Gift verified for #${params.dealId} - msgId: ${matchingGift.msgId}`);

      // Auto-execute deal (send agent's part)
      await autoExecuteAfterVerification(params.dealId, context.db, context.bridge);

      return {
        success: true,
        data: {
          dealId: params.dealId,
          verified: true,
          giftMsgId: matchingGift.msgId,
          giftSlug: matchingGift.slug,
          giftName: matchingGift.name,
          fromUserId: matchingGift.fromUserId,
          receivedAt: new Date(matchingGift.receivedAt).toISOString(),
          autoExecuted: true,
        },
      };
    }

    // Edge case: shouldn't reach here
    return {
      success: false,
      error: `Invalid deal configuration: user_gives_type = ${deal.user_gives_type}`,
    };
  } catch (error) {
    log.error({ err: error }, "Error verifying deal payment");
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
};
