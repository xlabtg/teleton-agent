import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { claimGiftPayment, isGiftPaymentUsed } from "../gift-matcher.js";

it("atomically allows one gift to verify only one deal in either path (#740)", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE deals (id TEXT PRIMARY KEY, status TEXT, user_payment_gift_msgid TEXT, user_payment_verified_at INTEGER); CREATE UNIQUE INDEX gift_unique ON deals(user_payment_gift_msgid) WHERE user_payment_gift_msgid IS NOT NULL; INSERT INTO deals (id, status) VALUES ('A', 'accepted'), ('B', 'payment_claimed')"
    );
    expect(claimGiftPayment(db, "A", "777", "accepted")).toBe(true);
    expect(isGiftPaymentUsed(db, "777")).toBe(true);
    expect(claimGiftPayment(db, "B", "777", "payment_claimed")).toBe(false);
    expect(() =>
      db.prepare("UPDATE deals SET user_payment_gift_msgid = '777' WHERE id = 'B'").run()
    ).toThrow();
  } finally {
    db.close();
  }
});

it("creates the uniqueness constraint in the actual deals database schema (#740)", async () => {
  const db = new Database(":memory:");
  vi.doMock("../../utils/module-db.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../utils/module-db.js")>()),
    openModuleDb: () => db,
    migrateFromMainDb: vi.fn(),
  }));
  const { openDealsDb, closeDealsDb } = await import("../db.js");
  try {
    openDealsDb();
    const insert = db.prepare(`INSERT INTO deals (id, status, user_telegram_id, chat_id,
      user_gives_type, user_gives_value_ton, agent_gives_type, agent_gives_value_ton,
      expires_at, user_payment_gift_msgid) VALUES (?, 'accepted', 1, '1', 'gift', 1, 'ton', 1, 9999999999, '777')`);
    insert.run("A");
    expect(() => insert.run("B")).toThrow(/UNIQUE/);
  } finally {
    closeDealsDb();
    vi.doUnmock("../../utils/module-db.js");
  }
});
