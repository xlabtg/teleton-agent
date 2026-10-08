import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import Database from "better-sqlite3";

// ─── Mocks ────────────────────────────────────────────────────────

vi.mock("../../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../wallet-service.js", () => ({
  getCachedTonClient: vi.fn(),
}));

vi.mock("../../utils/retry.js", () => ({
  withBlockchainRetry: vi.fn(),
}));

vi.mock("../../constants/limits.js", () => ({
  PAYMENT_TOLERANCE_RATIO: 0.99,
}));

vi.mock("../../utils/errors.js", () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const mocks = vi.hoisted(() => ({
  addressParse: vi.fn(),
  fromNano: vi.fn(),
}));

vi.mock("@ton/core", () => ({
  Address: { parse: mocks.addressParse },
}));

vi.mock("@ton/ton", () => ({
  fromNano: mocks.fromNano,
}));

// ─── Imports (after mocks) ────────────────────────────────────────

import {
  verifyPayment,
  verifyMemo,
  isTransactionUsed,
  cleanupOldTransactions,
} from "../payment-verifier.js";
import { getCachedTonClient } from "../wallet-service.js";
import { withBlockchainRetry } from "../../utils/retry.js";

// ─── Helpers ──────────────────────────────────────────────────────

const BOT_WALLET = "EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2";
const TX_HASH_BUF = Buffer.from("a".repeat(64), "hex");

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS used_transactions (
      tx_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL,
      game_type TEXT NOT NULL,
      used_at INTEGER NOT NULL
    )
  `);
  return db;
}

function makeTx(opts: {
  coins?: bigint;
  fromAddr?: string;
  now?: number;
  hash?: Buffer;
  comment?: string | null;
  type?: string;
}) {
  const {
    coins = 1000000000n,
    fromAddr = "EQSenderAddress",
    now = Math.floor(Date.now() / 1000),
    hash = TX_HASH_BUF,
    comment = "testuser",
    type = "internal",
  } = opts;

  // Build a mock Cell body that simulates parseComment behavior
  let body: any = null;
  if (comment !== null) {
    body = {
      beginParse: () => ({
        remainingBits: 64,
        loadUint: () => 0x0, // OP_COMMENT
        loadStringTail: () => comment,
      }),
    };
  }

  return {
    inMessage: {
      info: {
        type,
        value: { coins },
        src: {
          toString: (opts?: any) => fromAddr,
        },
      },
      body,
    },
    now,
    hash: () => hash,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe("PaymentVerifier", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();

    mocks.addressParse.mockImplementation((addr: string) => ({
      toString: () => addr,
    }));

    // withBlockchainRetry: pass-through — just call the function
    (withBlockchainRetry as Mock).mockImplementation((fn: () => any) => fn());
  });

  afterEach(() => {
    db.close();
  });

  // ═══════════════════════════════════════════════════════════════
  // verifyMemo()
  // ═══════════════════════════════════════════════════════════════

  describe("verifyMemo()", () => {
    it("should return false for null memo", () => {
      expect(verifyMemo(null, "user123")).toBe(false);
    });

    it("should return true for matching memo", () => {
      expect(verifyMemo("user123", "user123")).toBe(true);
    });

    it("should match @-prefixed memo against bare identifier", () => {
      expect(verifyMemo("@alice", "alice")).toBe(true);
    });

    it("should match bare memo against @-prefixed identifier", () => {
      expect(verifyMemo("alice", "@alice")).toBe(true);
    });

    it("should be case-insensitive", () => {
      expect(verifyMemo("Alice", "alice")).toBe(true);
      expect(verifyMemo("ALICE", "@alice")).toBe(true);
    });

    it("should trim whitespace on memo side", () => {
      expect(verifyMemo("  alice  ", "alice")).toBe(true);
    });

    it("should not trim identifier (only memo is trimmed)", () => {
      // Source code: cleanId = identifier.toLowerCase().replace(/^@/, "") — no trim()
      expect(verifyMemo("alice", "  alice  ")).toBe(false);
    });

    it("should return false for non-matching memo", () => {
      expect(verifyMemo("bob", "alice")).toBe(false);
    });

    it("should return false for empty string memo", () => {
      expect(verifyMemo("", "alice")).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // verifyPayment() — replay prevention (T1)
  // ═══════════════════════════════════════════════════════════════

  describe("verifyPayment()", () => {
    const baseParams = {
      botWalletAddress: BOT_WALLET,
      betAmount: 1,
      requestTime: Date.now() - 60_000, // 1 min ago
      gameType: "dice",
      userId: "testuser",
      maxPaymentAgeMinutes: 10,
    };

    it("should return verified=true for a valid matching transaction", async () => {
      const now = Math.floor(Date.now() / 1000);
      const tx = makeTx({ coins: 1000000000n, now, comment: "testuser" });

      mocks.fromNano.mockReturnValue("1.0");
      (getCachedTonClient as Mock).mockResolvedValue({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });

      const result = await verifyPayment(db, baseParams);

      expect(result.verified).toBe(true);
      expect(result.txHash).toBe(TX_HASH_BUF.toString("hex"));
      expect(result.amount).toBe("1 TON");
      expect(result.playerWallet).toBe("EQSenderAddress");
    });

    it("finds a matching payment after a full page of unrelated transfers", async () => {
      const now = Math.floor(Date.now() / 1000);
      const dust = Array.from({ length: 20 }, (_, i) => ({
        ...makeTx({ coins: 1n, now, comment: "unrelated" }),
        lt: BigInt(100 - i),
        hash: () => Buffer.from(`dust-${i}`),
      }));
      const payment = { ...makeTx({ coins: 1000000000n, now, comment: "testuser" }), lt: 79n };
      const getTransactions = vi.fn().mockResolvedValueOnce(dust).mockResolvedValueOnce([payment]);
      mocks.fromNano.mockReturnValue("1.0");
      (getCachedTonClient as Mock).mockResolvedValue({ getTransactions });

      const result = await verifyPayment(db, baseParams);

      expect(result.verified).toBe(true);
      expect(getTransactions).toHaveBeenCalledTimes(2);
      expect(getTransactions.mock.calls[1][1]).toMatchObject({ lt: "81", inclusive: false });
    });

    it("should return verified=false on second call with same txHash (replay prevention)", async () => {
      const now = Math.floor(Date.now() / 1000);
      const tx = makeTx({ coins: 1000000000n, now, comment: "testuser" });

      mocks.fromNano.mockReturnValue("1.0");
      (getCachedTonClient as Mock).mockResolvedValue({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });

      // First call — should succeed and INSERT the tx_hash
      const first = await verifyPayment(db, baseParams);
      expect(first.verified).toBe(true);

      // Second call — same tx returned by TonClient, INSERT OR IGNORE → changes===0
      const second = await verifyPayment(db, baseParams);
      expect(second.verified).toBe(false);
    });

    it("should skip transactions with amount below tolerance", async () => {
      const now = Math.floor(Date.now() / 1000);
      const tx = makeTx({ coins: 500000000n, now, comment: "testuser" });

      // 0.5 TON < 1 * 0.99 = 0.99 TON
      mocks.fromNano.mockReturnValue("0.5");
      (getCachedTonClient as Mock).mockResolvedValue({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });

      const result = await verifyPayment(db, baseParams);
      expect(result.verified).toBe(false);
    });

    it("should skip transactions before requestTime", async () => {
      // tx timestamp is before requestTime
      const txTimeSec = Math.floor((baseParams.requestTime - 120_000) / 1000);
      const tx = makeTx({ coins: 1000000000n, now: txTimeSec, comment: "testuser" });

      mocks.fromNano.mockReturnValue("1.0");
      (getCachedTonClient as Mock).mockResolvedValue({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });

      const result = await verifyPayment(db, baseParams);
      expect(result.verified).toBe(false);
    });

    it("should skip transactions with non-matching memo", async () => {
      const now = Math.floor(Date.now() / 1000);
      const tx = makeTx({ coins: 1000000000n, now, comment: "wronguser" });

      mocks.fromNano.mockReturnValue("1.0");
      (getCachedTonClient as Mock).mockResolvedValue({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });

      const result = await verifyPayment(db, baseParams);
      expect(result.verified).toBe(false);
    });

    it("should skip non-internal messages", async () => {
      const now = Math.floor(Date.now() / 1000);
      const tx = makeTx({ coins: 1000000000n, now, comment: "testuser", type: "external-in" });

      mocks.fromNano.mockReturnValue("1.0");
      (getCachedTonClient as Mock).mockResolvedValue({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });

      const result = await verifyPayment(db, baseParams);
      expect(result.verified).toBe(false);
    });

    it("should return error message on exception", async () => {
      (getCachedTonClient as Mock).mockRejectedValue(new Error("network down"));

      const result = await verifyPayment(db, baseParams);
      expect(result.verified).toBe(false);
      expect(result.error).toBe("network down");
    });

    // ─── T16: betAmount=0 edge case ─────────────────────────────

    it("should verify any amount when betAmount=0 (edge case: 0 * tolerance = 0)", async () => {
      const now = Math.floor(Date.now() / 1000);
      // Even a tiny amount satisfies amount >= 0 * 0.99 = 0
      const tx = makeTx({ coins: 1n, now, comment: "testuser" });

      mocks.fromNano.mockReturnValue("0.000000001");
      (getCachedTonClient as Mock).mockResolvedValue({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });

      const params = { ...baseParams, betAmount: 0 };
      const result = await verifyPayment(db, params);

      // 0.000000001 >= 0 * 0.99 = 0 → passes tolerance check
      expect(result.verified).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // isTransactionUsed()
  // ═══════════════════════════════════════════════════════════════

  describe("isTransactionUsed()", () => {
    it("should return false for unknown tx_hash", () => {
      expect(isTransactionUsed(db, "unknown_hash")).toBe(false);
    });

    it("should return true for a recorded tx_hash", () => {
      db.prepare(
        "INSERT INTO used_transactions (tx_hash, user_id, amount, game_type, used_at) VALUES (?, ?, ?, ?, unixepoch())"
      ).run("known_hash", "user1", 1.0, "dice");

      expect(isTransactionUsed(db, "known_hash")).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // cleanupOldTransactions()
  // ═══════════════════════════════════════════════════════════════

  describe("cleanupOldTransactions()", () => {
    it("should delete transactions older than retention period", () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - 60 * 24 * 60 * 60; // 60 days ago
      const recentTimestamp = Math.floor(Date.now() / 1000) - 1; // 1 second ago

      db.prepare(
        "INSERT INTO used_transactions (tx_hash, user_id, amount, game_type, used_at) VALUES (?, ?, ?, ?, ?)"
      ).run("old_tx", "user1", 1.0, "dice", oldTimestamp);

      db.prepare(
        "INSERT INTO used_transactions (tx_hash, user_id, amount, game_type, used_at) VALUES (?, ?, ?, ?, ?)"
      ).run("recent_tx", "user2", 2.0, "slots", recentTimestamp);

      const deleted = cleanupOldTransactions(db, 30);

      expect(deleted).toBe(1);
      expect(isTransactionUsed(db, "old_tx")).toBe(false);
      expect(isTransactionUsed(db, "recent_tx")).toBe(true);
    });

    it("should return 0 when no old transactions exist", () => {
      const deleted = cleanupOldTransactions(db);
      expect(deleted).toBe(0);
    });
  });
});
