import { describe, it, expect, vi, beforeEach } from "vitest";
import { SendMode } from "@ton/core";

// ─── Mocks ────────────────────────────────────────────────────────

vi.mock("../../utils/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../utils/retry.js", () => ({
  withBlockchainRetry: (fn: () => unknown) => fn(),
}));

vi.mock("../../constants/timeouts.js", () => ({
  TON_CONFIRM_TIMEOUT_MS: 120,
  TON_CONFIRM_POLL_INTERVAL_MS: 10,
}));

vi.mock("../wallet-service.js", () => ({ invalidateTonClientCache: vi.fn() }));

// ─── Imports (after mocks) ────────────────────────────────────────

import { walletTxLt, confirmWalletTx, sendWalletTx, tonExplorerTxUrl } from "../confirm.js";

// ─── Helpers ──────────────────────────────────────────────────────

interface TxOpts {
  lt: bigint;
  external?: boolean;
  computeOk?: boolean;
  actionOk?: boolean;
  hash?: string;
  now?: number;
}

function makeTx(o: TxOpts) {
  return {
    lt: o.lt,
    now: o.now ?? 1000,
    inMessage: { info: { type: o.external === false ? "internal" : "external-in" } },
    description: {
      type: "generic",
      computePhase: { type: "vm", success: o.computeOk ?? true, exitCode: 0 },
      actionPhase: { success: o.actionOk ?? true, resultCode: 0, noFunds: false },
    },
    hash: () => Buffer.from((o.hash ?? "ab".repeat(32)).padEnd(64, "0").slice(0, 64), "hex"),
  } as any;
}

const ADDR = { toString: () => "EQwallet" } as any;

function fakeClient(getTransactions: ReturnType<typeof vi.fn>) {
  return { getTransactions } as any;
}

// ─── Tests ────────────────────────────────────────────────────────

describe("walletTxLt", () => {
  it("returns the latest transaction lt", async () => {
    const getTx = vi.fn().mockResolvedValue([makeTx({ lt: 77n })]);
    expect(await walletTxLt(fakeClient(getTx), ADDR)).toBe(77n);
    expect(getTx).toHaveBeenCalledWith(ADDR, { limit: 1 });
  });

  it("returns 0n for a wallet with no transactions", async () => {
    const getTx = vi.fn().mockResolvedValue([]);
    expect(await walletTxLt(fakeClient(getTx), ADDR)).toBe(0n);
  });
});

describe("confirmWalletTx", () => {
  it("returns the real hash for a confirmed external-in tx", async () => {
    const getTx = vi
      .fn()
      .mockResolvedValue([makeTx({ lt: 10n, hash: "cd".repeat(32), now: 2000 })]);
    expect(await confirmWalletTx(fakeClient(getTx), ADDR, 5n)).toEqual({
      hash: "cd".repeat(32),
      at: 2_000_000,
    });
  });

  it("returns null when the action phase failed (funds never left)", async () => {
    const getTx = vi.fn().mockResolvedValue([makeTx({ lt: 10n, actionOk: false })]);
    expect(await confirmWalletTx(fakeClient(getTx), ADDR, 5n)).toBeNull();
  });

  it("ignores incoming (internal) txs and times out", async () => {
    const getTx = vi.fn().mockResolvedValue([makeTx({ lt: 10n, external: false })]);
    expect(await confirmWalletTx(fakeClient(getTx), ADDR, 5n)).toBeNull();
  });

  it("ignores txs at or before the pre-send snapshot lt", async () => {
    const getTx = vi.fn().mockResolvedValue([makeTx({ lt: 5n })]);
    expect(await confirmWalletTx(fakeClient(getTx), ADDR, 5n)).toBeNull();
  });
});

describe("sendWalletTx", () => {
  const secretKey = Buffer.alloc(64);

  function fakeContract() {
    return {
      address: ADDR,
      getSeqno: vi.fn().mockResolvedValue(7),
      sendTransfer: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it("returns the confirmed tx and broadcasts once", async () => {
    const contract = fakeContract();
    const getTx = vi
      .fn()
      .mockResolvedValueOnce([makeTx({ lt: 100n, external: false })]) // snapshot
      .mockResolvedValue([makeTx({ lt: 101n, hash: "ef".repeat(32), now: 3000 })]); // confirm

    const result = await sendWalletTx(fakeClient(getTx), contract as never, {
      secretKey,
      messages: [],
    });

    expect(result).toEqual({ hash: "ef".repeat(32), seqno: 7, at: 3_000_000 });
    expect(contract.sendTransfer).toHaveBeenCalledTimes(1);
    expect(contract.sendTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ seqno: 7, sendMode: SendMode.PAY_GAS_SEPARATELY })
    );
  });

  it("confirms via the chain even when the broadcast call throws but the message lands", async () => {
    const contract = fakeContract();
    contract.sendTransfer.mockRejectedValue(new Error("ETIMEDOUT"));
    const getTx = vi
      .fn()
      .mockResolvedValueOnce([]) // snapshot
      .mockResolvedValue([makeTx({ lt: 1n, hash: "11".repeat(32) })]);

    const result = await sendWalletTx(fakeClient(getTx), contract as never, {
      secretKey,
      messages: [],
    });
    expect(result?.hash).toBe("11".repeat(32));
  });

  it("reports uncertainty when broadcast and confirmation are unavailable", async () => {
    const contract = fakeContract();
    contract.sendTransfer.mockRejectedValue(new Error("network down"));
    const getTx = vi.fn().mockResolvedValue([]);

    await expect(
      sendWalletTx(fakeClient(getTx), contract as never, { secretKey, messages: [] })
    ).rejects.toThrow("unknown/pending");
  });
});

describe("tonExplorerTxUrl", () => {
  it("builds a tonviewer link", () => {
    expect(tonExplorerTxUrl("abc")).toBe("https://tonviewer.com/transaction/abc");
  });
});
