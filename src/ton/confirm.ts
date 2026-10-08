import type { WalletContractV5R1, TonClient, OpenedContract } from "@ton/ton";
import { internal, SendMode, type Address, type MessageRelaxed, type Sender } from "@ton/core";
import { invalidateTonClientCache } from "./wallet-service.js";
import { createLogger } from "../utils/logger.js";
import { withBlockchainRetry } from "../utils/retry.js";
import { TON_CONFIRM_TIMEOUT_MS, TON_CONFIRM_POLL_INTERVAL_MS } from "../constants/timeouts.js";

const log = createLogger("TON");

type WalletV5R1 = WalletContractV5R1;

export interface ConfirmedTx {
  /** Real on-chain account-transaction hash (hex) — verifiable on TON explorers. */
  hash: string;
  /** Unix-ms timestamp of the confirmed transaction. */
  at: number;
}

export interface SentTx extends ConfirmedTx {
  /** Wallet seqno consumed by this transfer. */
  seqno: number;
}

/** Explorer link for a confirmed transaction (endpoints are mainnet — see endpoint.ts). */
export function tonExplorerTxUrl(hash: string): string {
  return `https://tonviewer.com/transaction/${hash}`;
}

function isServerError(error: unknown): boolean {
  const err = error as { status?: number; response?: { status?: number } };
  const status = err?.status ?? err?.response?.status;
  return status === 429 || (status !== undefined && status >= 500);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Latest transaction lt for the wallet — snapshot this before sending to identify our own tx. */
export async function walletTxLt(client: TonClient, walletAddress: Address): Promise<bigint> {
  const recent = await withBlockchainRetry(
    () => client.getTransactions(walletAddress, { limit: 1 }),
    "getTransactions"
  );
  return recent[0]?.lt ?? 0n;
}

/**
 * Locate the wallet's own outgoing transaction and confirm it committed. Our send is the
 * newest `external-in` tx past the pre-send `lt` snapshot — incoming payments are `internal`
 * and the tx-lock serialises our sends, so the match is unambiguous. A seqno bump alone is
 * not enough: the action phase must also succeed, else the funds never left the wallet.
 */
export async function confirmWalletTx(
  client: TonClient,
  walletAddress: Address,
  sinceLt: bigint,
  validUntil?: number,
  onRejected?: () => void
): Promise<ConfirmedTx | null> {
  const deadline = Math.max(
    Date.now() + TON_CONFIRM_TIMEOUT_MS,
    (validUntil ?? 0) * 1000 + Math.min(30_000, TON_CONFIRM_TIMEOUT_MS / 3)
  );

  while (Date.now() < deadline) {
    try {
      const txs = await client.getTransactions(walletAddress, { limit: 10 });
      const ours = txs.find((tx) => tx.inMessage?.info.type === "external-in" && tx.lt > sinceLt);

      if (ours) {
        const d = ours.description;
        if (d.type !== "generic") {
          log.error({ type: d.type }, "Unexpected transfer transaction type");
          onRejected?.();
          return null;
        }
        const computeOk = d.computePhase.type === "vm" && d.computePhase.success;
        const actionOk = d.actionPhase?.success === true;
        if (!computeOk || !actionOk) {
          log.error(
            {
              exitCode: d.computePhase.type === "vm" ? d.computePhase.exitCode : undefined,
              actionResult: d.actionPhase?.resultCode,
              noFunds: d.actionPhase?.noFunds,
            },
            "Transfer failed on-chain — funds did not leave the wallet"
          );
          onRejected?.();
          return null;
        }
        return { hash: ours.hash().toString("hex"), at: ours.now * 1000 };
      }
    } catch (error) {
      log.debug({ err: error }, "Confirm poll failed; retrying");
    }
    await sleep(TON_CONFIRM_POLL_INTERVAL_MS);
  }

  return null;
}

/**
 * Broadcast a transfer once, then confirm it on-chain and return the real hash. We confirm
 * regardless of the broadcast call's outcome — the message can land even if the RPC response
 * errors, and re-broadcasting a consumed seqno is a no-op. Returns null for a confirmed on-chain rejection; throws a pending error
 * if the finality window expires without a conclusive result (never an optimistic success). Callers MUST hold the wallet tx-lock.
 */
export async function sendWalletTx(
  client: TonClient,
  contract: OpenedContract<WalletV5R1>,
  args: { secretKey: Buffer; messages: MessageRelaxed[]; sendMode?: SendMode }
): Promise<SentTx | null> {
  const seqno = await withBlockchainRetry(() => contract.getSeqno(), "getSeqno");
  const sinceLt = await walletTxLt(client, contract.address);

  // Explicit expiry always falls inside the confirmation window, with indexing margin.
  const validUntil =
    Math.floor(Date.now() / 1000) + Math.max(0, Math.floor(TON_CONFIRM_TIMEOUT_MS / 1000) - 30);
  let broadcastError: unknown;
  try {
    await contract.sendTransfer({
      seqno,
      timeout: validUntil,
      secretKey: args.secretKey,
      sendMode: args.sendMode ?? SendMode.PAY_GAS_SEPARATELY,
      messages: args.messages,
    });
  } catch (error) {
    broadcastError = error;
    if (isServerError(error)) invalidateTonClientCache();
    log.warn({ err: error }, "Broadcast errored — verifying on-chain whether it landed");
  }

  let rejected = false;
  const confirmed = await confirmWalletTx(client, contract.address, sinceLt, validUntil, () => {
    rejected = true;
  });
  if (!confirmed) {
    if (rejected) return null;
    throw new WalletTransferPendingError(seqno, validUntil, broadcastError);
  }
  return { hash: confirmed.hash, seqno, at: confirmed.at };
}

/** RPC/indexer uncertainty must never be represented as a safe-to-retry failure. */
export class WalletTransferPendingError extends Error {
  constructor(
    public readonly seqno: number,
    public readonly validUntil: number,
    cause?: unknown
  ) {
    super(
      `TON transfer status unknown/pending (seqno ${seqno}); reconcile on-chain before retrying`,
      { cause }
    );
    this.name = "WalletTransferPendingError";
  }
}

/** Let contract SDKs construct messages without bypassing our wallet validity/confirmation path. */
export function createWalletMessageCollector(address: Address): {
  sender: Sender;
  messages: MessageRelaxed[];
} {
  const messages: MessageRelaxed[] = [];
  const sender: Sender = {
    address,
    send: async (args) => {
      if (args.sendMode !== undefined && args.sendMode !== SendMode.PAY_GAS_SEPARATELY) {
        throw new Error("Unsupported wallet send mode");
      }
      messages.push(
        internal({
          to: args.to,
          value: args.value,
          body: args.body,
          bounce: args.bounce ?? true,
          init: args.init ?? undefined,
        })
      );
    },
  };
  return { sender, messages };
}
