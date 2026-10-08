import { WalletContractV5R1, toNano, internal } from "@ton/ton";
import { Address } from "@ton/core";
import { getKeyPair, getCachedTonClient } from "./wallet-service.js";
import { createLogger } from "../utils/logger.js";
import { withTxLock } from "./tx-lock.js";
import { WalletTransferPendingError, sendWalletTx, type SentTx } from "./confirm.js";
import { getAuditInstance, type FinancialAuditDetails } from "../services/audit.js";

const log = createLogger("TON");

export interface SendTonParams {
  toAddress: string;
  amount: number;
  comment?: string;
  bounce?: boolean;
}

export type SendTonResult = SentTx;

/**
 * Send TON and return the real, explorer-verifiable transaction once it has committed
 * on-chain. Returns null when the transfer cannot be confirmed (invalid params, wallet not
 * initialized, or not committed within the finality window) — never an optimistic success.
 * Serialized via the wallet tx-lock so the seqno read → send → confirm sequence is atomic.
 */
export async function sendTon(params: SendTonParams): Promise<SendTonResult | null> {
  return withTxLock(async () => {
    const { toAddress, amount, comment = "", bounce = false } = params;

    if (!Number.isFinite(amount) || amount <= 0) {
      log.error({ amount }, "Invalid transfer amount");
      _logFinancial({
        operation: "ton_transfer",
        amount,
        asset: "TON",
        recipient: toAddress,
        comment: comment || undefined,
        status: "failed",
        error: "Invalid transfer amount",
      });
      return null;
    }

    let recipientAddress: Address;
    try {
      recipientAddress = Address.parse(toAddress);
    } catch (error) {
      log.error({ err: error }, `Invalid recipient address: ${toAddress}`);
      _logFinancial({
        operation: "ton_transfer",
        amount,
        asset: "TON",
        recipient: toAddress,
        comment: comment || undefined,
        status: "failed",
        error: "Invalid recipient address",
      });
      return null;
    }

    const keyPair = await getKeyPair();
    if (!keyPair) {
      log.error("Wallet not initialized");
      _logFinancial({
        operation: "ton_transfer",
        amount,
        asset: "TON",
        recipient: toAddress,
        comment: comment || undefined,
        status: "failed",
        error: "Wallet not initialized",
      });
      return null;
    }

    const wallet = WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey });
    const client = await getCachedTonClient();
    const contract = client.open(wallet);

    try {
      const sent = await sendWalletTx(client, contract, {
        secretKey: keyPair.secretKey,
        messages: [
          internal({ to: recipientAddress, value: toNano(amount), body: comment, bounce }),
        ],
      });

      if (!sent) {
        log.error({ toAddress, amount }, "Transfer not confirmed on-chain within timeout");
        _logFinancial({
          operation: "ton_transfer",
          amount,
          asset: "TON",
          recipient: toAddress,
          comment: comment || undefined,
          status: "failed",
          error: "Transfer not confirmed on-chain within timeout",
        });
        return null;
      }

      log.info(
        `Sent ${amount} TON to ${toAddress.slice(0, 8)}... — seqno ${sent.seqno}, tx ${sent.hash.slice(0, 8)}...`
      );

      _logFinancial({
        operation: "ton_transfer",
        amount,
        asset: "TON",
        recipient: toAddress,
        comment: comment || undefined,
        txId: sent.hash,
        status: "success",
      });

      return sent;
    } catch (error: unknown) {
      log.error({ err: error }, "Error sending TON");

      _logFinancial({
        operation: "ton_transfer",
        amount,
        asset: "TON",
        recipient: toAddress,
        comment: comment || undefined,
        status: error instanceof WalletTransferPendingError ? "pending" : "failed",
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  });
}

/**
 * Write a financial audit entry via the AuditService singleton.
 * Silently skips if the audit service has not been initialized yet
 * (e.g. when running without WebUI/API). Errors are caught so they
 * never abort the financial operation itself.
 */
function _logFinancial(details: FinancialAuditDetails): void {
  try {
    getAuditInstance()?.logFinancial(details);
  } catch {
    // Audit failures must never interrupt financial operations
  }
}
