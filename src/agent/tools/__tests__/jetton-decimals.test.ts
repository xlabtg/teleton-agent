import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadWallet: vi.fn(),
  getCachedTonClient: vi.fn(),
  tonapiFetch: vi.fn(),
  openWallet: vi.fn(),
  sendWalletTx: vi.fn(),
  withTxLock: vi.fn(),
  storeCoins: vi.fn(),
}));

vi.mock("../../../ton/wallet-service.js", () => ({
  loadWallet: mocks.loadWallet,
  getCachedTonClient: mocks.getCachedTonClient,
}));

vi.mock("../../../constants/api-endpoints.js", () => ({
  tonapiFetch: mocks.tonapiFetch,
}));

vi.mock("../../../ton/wallet-open.js", () => ({ openWallet: mocks.openWallet }));
vi.mock("../../../ton/confirm.js", () => ({
  sendWalletTx: mocks.sendWalletTx,
  tonExplorerTxUrl: vi.fn(() => "https://example.test/tx"),
}));
vi.mock("../../../ton/tx-lock.js", () => ({ withTxLock: mocks.withTxLock }));

vi.mock("@ton/core", () => ({
  Address: {
    parse: vi.fn((address: string) => ({ toString: () => address })),
  },
  beginCell: vi.fn(() => ({
    storeUint: vi.fn().mockReturnThis(),
    storeCoins: mocks.storeCoins.mockReturnThis(),
    storeAddress: vi.fn().mockReturnThis(),
    storeBit: vi.fn().mockReturnThis(),
    storeStringTail: vi.fn().mockReturnThis(),
    storeRef: vi.fn().mockReturnThis(),
    endCell: vi.fn(() => ({})),
  })),
}));

vi.mock("@ton/ton", () => ({
  internal: vi.fn(() => ({})),
  toNano: vi.fn(() => 1n),
}));

import { jettonBalancesExecutor } from "../ton/jetton-balances.js";
import { jettonSendExecutor } from "../ton/jetton-send.js";

const walletAddress = "EQSender";
const jettonAddress = "EQJetton";

function response(body: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

describe("TON jetton decimal handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadWallet.mockReturnValue({ address: walletAddress });
    mocks.getCachedTonClient.mockResolvedValue({});
    mocks.openWallet.mockResolvedValue({ keyPair: { secretKey: new Uint8Array() }, contract: {} });
    mocks.sendWalletTx.mockResolvedValue({ hash: "tx-hash" });
    mocks.withTxLock.mockImplementation((callback: () => unknown) => callback());
  });

  it("sends five base units for a zero-decimal jetton", async () => {
    mocks.tonapiFetch.mockResolvedValue(
      response({
        balances: [
          {
            balance: "5",
            wallet_address: { address: "EQJettonWallet" },
            jetton: { address: jettonAddress, decimals: 0, symbol: "ZERO" },
          },
        ],
      })
    );

    const result = await jettonSendExecutor(
      { jetton_address: jettonAddress, to: "EQRecipient", amount: 5 },
      {} as never
    );

    expect(result.success).toBe(true);
    expect(mocks.storeCoins).toHaveBeenCalledWith(5n);
  });

  it("formats a zero-decimal balance without scaling it by 10^9", async () => {
    mocks.tonapiFetch.mockResolvedValue(
      response({
        balances: [
          {
            balance: "5",
            wallet_address: { address: "EQJettonWallet" },
            jetton: {
              address: jettonAddress,
              decimals: 0,
              symbol: "ZERO",
              name: "Zero Decimal",
              verification: "whitelist",
              score: 100,
            },
          },
        ],
      })
    );

    const result = await jettonBalancesExecutor({}, {} as never);

    expect(result).toMatchObject({
      success: true,
      data: {
        balances: [{ balance: "5", rawBalance: "5", decimals: 0 }],
      },
    });
  });
});
