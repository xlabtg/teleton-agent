import { expect, it, vi } from "vitest";
import { readTransactionHistory } from "../transaction-history.js";

it("finds payments beyond a page of dust and bounds scanning (#762)", async () => {
  const tx = (lt: number, now = 100) => ({ lt: BigInt(lt), now, hash: () => Buffer.alloc(32, lt) });
  const first = Array.from({ length: 20 }, (_, i) => tx(100 - i));
  const payment = tx(79);
  const getTransactions = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce([payment]);
  const result = await readTransactionHistory({ getTransactions } as any, {} as any, 90_000);
  expect(result).toContain(payment);
  expect(getTransactions.mock.calls[1][1]).toMatchObject({
    lt: "81",
    hash: first[19].hash().toString("base64"),
    inclusive: false,
  });
  const busy = vi.fn().mockImplementation(async () => first);
  expect(
    (await readTransactionHistory({ getTransactions: busy } as any, {} as any, 0)).length
  ).toBeLessThanOrEqual(200);
  expect(busy.mock.calls.length).toBeLessThanOrEqual(10);
});
