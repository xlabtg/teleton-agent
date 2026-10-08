import { afterEach, describe, expect, it, vi } from "vitest";
import { TON_CONFIRM_TIMEOUT_MS } from "../../constants/timeouts.js";
vi.mock("../wallet-service.js", () => ({ invalidateTonClientCache: vi.fn() }));
vi.mock("../../utils/retry.js", () => ({ withBlockchainRetry: (fn: () => unknown) => fn() }));
import { sendWalletTx, WalletTransferPendingError } from "../confirm.js";
afterEach(() => vi.useRealTimers());
describe("wallet validity window (#749)", () => {
  it.each([true, false])(
    "waits for late inclusion even when broadcast success=%s",
    async (success) => {
      vi.useFakeTimers();
      const started = Date.now();
      const tx = {
        lt: 1n,
        now: Math.floor(started / 1000) + 25,
        inMessage: { info: { type: "external-in" } },
        description: {
          type: "generic",
          computePhase: { type: "vm", success: true },
          actionPhase: { success: true },
        },
        hash: () => Buffer.alloc(32, 1),
      };
      const client = {
        getTransactions: vi.fn(async () => (Date.now() - started >= 25_000 ? [tx] : [])),
      };
      const contract = {
        address: {},
        getSeqno: vi.fn(async () => 7),
        sendTransfer: vi.fn(async () => {
          if (!success) throw new Error("network unavailable");
        }),
      };
      const promise = sendWalletTx(client as never, contract as never, {
        secretKey: Buffer.alloc(64),
        messages: [],
      }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await promise).toMatchObject({ seqno: 7, hash: "01".repeat(32) });
      expect(contract.sendTransfer).toHaveBeenCalledTimes(1);
      const expiry = (contract.sendTransfer.mock.calls[0] as unknown as [{ timeout: number }])[0]
        .timeout;
      expect(expiry).toBe(Math.floor(started / 1000) + 45);
      expect(expiry * 1000).toBeLessThan(started + TON_CONFIRM_TIMEOUT_MS);
    }
  );
  it("keeps status unknown until expiry and indexing margin have elapsed", async () => {
    vi.useFakeTimers();
    const contract = {
      address: {},
      getSeqno: vi.fn(async () => 7),
      sendTransfer: vi.fn(async () => undefined),
    };
    let settled = false;
    const promise = sendWalletTx(
      { getTransactions: vi.fn(async () => []) } as never,
      contract as never,
      { secretKey: Buffer.alloc(64), messages: [] }
    ).catch((error) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await promise).toBeInstanceOf(WalletTransferPendingError);
  });
});
