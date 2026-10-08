import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
vi.mock("../../ton/transfer.js", () => ({ sendTon: vi.fn() }));
import { sendTon } from "../../ton/transfer.js";
import { WalletTransferPendingError } from "../../ton/confirm.js";
import { executeDeal } from "../executor.js";

it("keeps the payout lock while on-chain confirmation remains unknown (#749)", async () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE deals (id TEXT, status TEXT, agent_gives_type TEXT, agent_gives_ton_amount REAL,
    user_payment_wallet TEXT, agent_sent_at INTEGER, agent_sent_tx_status TEXT, notes TEXT);
    INSERT INTO deals (id, status, agent_gives_type, agent_gives_ton_amount, user_payment_wallet)
    VALUES ('A', 'verified', 'ton', 1, 'EQRecipient')`);
  vi.mocked(sendTon).mockRejectedValueOnce(new WalletTransferPendingError(7, 100));
  try {
    expect((await executeDeal("A", db, {} as never)).success).toBe(false);
    const deal = db.prepare("SELECT * FROM deals").get() as {
      status: string;
      agent_sent_at: number;
      agent_sent_tx_status: string;
    };
    expect(deal.status).toBe("verified");
    expect(deal.agent_sent_at).toBeGreaterThan(0);
    expect(deal.agent_sent_tx_status).toBe("pending");
    expect((await executeDeal("A", db, {} as never)).success).toBe(false);
    expect(sendTon).toHaveBeenCalledTimes(1);
  } finally {
    db.close();
  }
});
