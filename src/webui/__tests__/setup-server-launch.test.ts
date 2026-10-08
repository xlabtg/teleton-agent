/**
 * AUDIT-H7 regression tests.
 *
 * POST /api/setup/launch used to be an unauthenticated, unrate-limited endpoint
 * that wrote a plaintext token into config.yaml and returned it. These tests
 * pin the new behavior:
 *
 *   1. Requests without a valid one-time nonce are rejected (401).
 *   2. After 5 requests in a minute, further requests are rate-limited (429).
 *   3. The token in config.yaml is stored as a scrypt hash — the raw value
 *      cannot be recovered by reading the file.
 *   4. A successful launch consumes the nonce so no second caller can rotate
 *      the token.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";

// Mock the workspace path so every test runs against an isolated config.
let tmpRoot = "";
vi.mock("../../workspace/paths.js", () => ({
  get TELETON_ROOT() {
    return tmpRoot;
  },
}));

// Mock the logger so we don't spam the test output.
vi.mock("../../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Setup routes pull in wallet + telegram modules we don't exercise here.
// Stub them so we don't need a live SQLite/Telegram setup.
vi.mock("../../ton/wallet-service.js", () => ({
  walletExists: vi.fn(() => false),
  getWalletAddress: vi.fn(() => null),
  generateWallet: vi.fn(),
  importWallet: vi.fn(),
  saveWallet: vi.fn(),
  loadWallet: vi.fn(() => null),
}));

vi.mock("../../workspace/manager.js", () => ({
  ensureWorkspace: vi.fn(() =>
    Promise.resolve({
      root: "/tmp/teleton-test",
      workspace: "/tmp/teleton-test/workspace",
      identityPath: "/tmp/teleton-test/workspace/IDENTITY.md",
      configPath: "/tmp/teleton-test/config.yaml",
      sessionPath: "/tmp/teleton-test/telegram_session.txt",
    })
  ),
  isNewWorkspace: vi.fn(() => true),
}));

vi.mock("../setup-auth.js", () => ({
  TelegramAuthManager: class {
    sendCode = vi.fn();
    verifyCode = vi.fn();
    verifyPassword = vi.fn();
    resendCode = vi.fn();
    startQrSession = vi.fn();
    cancelSession = vi.fn();
  },
}));

import { walletExists, generateWallet, importWallet } from "../../ton/wallet-service.js";
import { SetupServer, SETUP_NONCE_HEADER } from "../setup-server.js";
import { verifyToken } from "../middleware/token-hash.js";

// Reach into the Hono app to exercise handlers without binding a real port.
// The SetupServer only exposes start()/stop() publicly, so we grab the
// internal `app.fetch` using a lightweight accessor for tests.
function fetchApp(server: SetupServer): (req: Request) => Promise<Response> {
  const app = (server as unknown as { app: { fetch: (req: Request) => Promise<Response> } }).app;
  return (req: Request) => app.fetch(req);
}

function launchRequest(nonce: string | null): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (nonce !== null) headers[SETUP_NONCE_HEADER] = nonce;
  return new Request("http://localhost:7777/api/setup/launch", {
    method: "POST",
    headers,
  });
}

describe("SetupServer.POST /api/setup/launch (AUDIT-H7)", () => {
  let server: SetupServer;
  let configPath: string;

  it.each([
    { Origin: "https://evil.example", "Content-Type": "application/json" },
    { Host: "evil.example:7777", "Content-Type": "application/json" },
    { "Content-Type": "text/plain" },
  ])("rejects hostile setup requests (#741)", async (headers) => {
    const response = await fetchApp(server)(
      new Request("http://localhost:7777/api/setup/wallet/generate", {
        method: "POST",
        headers,
        body: "{}",
      })
    );
    expect([403, 415]).toContain(response.status);
  });
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "teleton-h7-"));
    configPath = join(tmpRoot, "config.yaml");
    writeFileSync(configPath, YAML.stringify({ webui: { enabled: false } }), "utf-8");
    server = new SetupServer(7777);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it.each(["generate", "import"])(
    "does not implicitly overwrite existing wallets via %s (#741)",
    async (route) => {
      vi.mocked(walletExists).mockReturnValueOnce(true);
      const res = await fetchApp(server)(
        new Request(`http://localhost:7777/api/setup/wallet/${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mnemonic: "test" }),
        })
      );
      expect(res.status).toBe(409);
      expect(generateWallet).not.toHaveBeenCalled();
      expect(importWallet).not.toHaveBeenCalled();
    }
  );

  it("rejects launch requests with no nonce (401)", async () => {
    const res = await fetchApp(server)(launchRequest(null));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/nonce/i);
  });

  it("rejects launch requests with a wrong nonce (401)", async () => {
    const res = await fetchApp(server)(launchRequest("not-the-real-nonce"));
    expect(res.status).toBe(401);
  });

  it("accepts a launch request with the correct nonce and returns a token", async () => {
    const res = await fetchApp(server)(launchRequest(server.getNonce()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { token: string } };
    expect(body.success).toBe(true);
    expect(body.data.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores a scrypt hash in config.yaml — the raw token is not recoverable", async () => {
    const res = await fetchApp(server)(launchRequest(server.getNonce()));
    const body = (await res.json()) as { success: boolean; data: { token: string } };
    expect(body.success).toBe(true);
    const rawToken = body.data.token;

    const persisted = YAML.parse(readFileSync(configPath, "utf-8")) as {
      webui: { auth_token?: string; auth_token_hash?: string };
    };

    // The raw token must not appear anywhere in the persisted config.
    expect(readFileSync(configPath, "utf-8")).not.toContain(rawToken);
    expect(persisted.webui.auth_token).toBeUndefined();

    // The stored hash must verify against the raw token — and nothing else.
    const hash = persisted.webui.auth_token_hash;
    expect(hash).toBeDefined();
    expect(hash!.startsWith("scrypt$")).toBe(true);
    expect(verifyToken(rawToken, hash!)).toBe(true);
    expect(verifyToken("wrong-token", hash!)).toBe(false);
  });

  it("consumes the nonce on success — a second caller gets 409", async () => {
    const first = await fetchApp(server)(launchRequest(server.getNonce()));
    expect(first.status).toBe(200);

    const second = await fetchApp(server)(launchRequest(server.getNonce()));
    expect(second.status).toBe(409);
  });

  it("rate-limits repeated failed attempts: the 6th request in a minute returns 429", async () => {
    // Five rejected-but-allowed-through attempts in a row.
    for (let i = 0; i < 5; i++) {
      const res = await fetchApp(server)(launchRequest("bad-nonce"));
      expect(res.status).toBe(401);
    }

    // The 6th (even with the correct nonce!) must be blocked by the limiter,
    // proving the limiter runs *before* nonce validation.
    const sixth = await fetchApp(server)(launchRequest(server.getNonce()));
    expect(sixth.status).toBe(429);
    const retryAfter = sixth.headers.get("Retry-After");
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});
