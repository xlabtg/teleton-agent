import type { TonClient } from "@ton/ton";
import type { Address, Transaction } from "@ton/core";
import { withBlockchainRetry } from "../utils/retry.js";

/** Scan newest-first through the request window, bounded to 200 transactions. */
export async function readTransactionHistory(
  client: TonClient,
  address: Address,
  sinceMs: number,
  maxTransactions = 200
): Promise<Transaction[]> {
  const result: Transaction[] = [];
  let cursor: { lt: string; hash: string; inclusive: false } | undefined;
  const seen = new Set<string>();
  for (
    let pageNumber = 0;
    pageNumber < Math.ceil(maxTransactions / 20) + 1 && result.length < maxTransactions;
    pageNumber++
  ) {
    const limit = Math.min(20, maxTransactions - result.length);
    const page = await withBlockchainRetry(
      () => client.getTransactions(address, { limit, ...cursor }),
      "getTransactions"
    );
    if (!page.length) break;
    for (const tx of page) {
      const key = tx.hash().toString("hex");
      if (!seen.has(key)) {
        seen.add(key);
        result.push(tx);
      }
    }
    const last = page[page.length - 1];
    if (last.now * 1000 < sinceMs || page.length < limit || last.lt === undefined) break;
    const next = {
      lt: last.lt.toString(),
      hash: last.hash().toString("base64"),
      inclusive: false as const,
    };
    if (cursor?.lt === next.lt && cursor.hash === next.hash) break;
    cursor = next;
  }
  return result.slice(0, maxTransactions);
}
