import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { tempRoot, runGocoonMock } = vi.hoisted(() => ({
  tempRoot: require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "teleton-gocoon-permissions-")
  ) as string,
  runGocoonMock: vi.fn(),
}));

vi.mock("../../workspace/paths.js", () => ({ TELETON_ROOT: tempRoot }));

vi.mock("../installer.js", () => ({
  ensureGocoonBinaries: vi.fn(async () => ({ gocoon: "/tmp/gocoon" })),
}));

vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => runGocoonMock(...args),
  spawn: vi.fn(),
}));

const { gocoonInit } = await import("../cli.js");
const { clientConfigPath, gocoonDataDir, walletPath } = await import("../paths.js");

const mode = (path: string): number => statSync(path).mode & 0o777;
type ExecCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void;

describe("gocoon data permissions", () => {
  beforeEach(() => {
    rmSync(gocoonDataDir(), { recursive: true, force: true });
    runGocoonMock.mockReset();
  });

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("creates the gocoon data directory with mode 0o700", async () => {
    const previousUmask = process.umask(0o022);
    runGocoonMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
        mkdirSync(gocoonDataDir(), { recursive: true });
        writeFileSync(walletPath(), "{}", { mode: 0o600 });
        callback(null, {
          stdout: JSON.stringify({ fund_address: "fund", owner_address: "owner" }),
          stderr: "",
        });
      }
    );

    try {
      await gocoonInit();
      expect(mode(gocoonDataDir())).toBe(0o700);
      expect(mode(walletPath())).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("tightens an existing gocoon data directory to mode 0o700", async () => {
    mkdirSync(gocoonDataDir(), { recursive: true });
    chmodSync(gocoonDataDir(), 0o755);
    runGocoonMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecCallback) =>
        callback(null, {
          stdout: JSON.stringify({ fund_address: "fund", owner_address: "owner" }),
          stderr: "",
        })
    );

    await gocoonInit();

    expect(mode(gocoonDataDir())).toBe(0o700);
  });

  it("tightens an existing wallet to mode 0o600 when it is reused", async () => {
    mkdirSync(gocoonDataDir(), { recursive: true });
    writeFileSync(walletPath(), "{}", { mode: 0o644 });
    writeFileSync(clientConfigPath(), "{}", { mode: 0o600 });
    chmodSync(walletPath(), 0o644);
    runGocoonMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecCallback) =>
        callback(null, {
          stdout: JSON.stringify({
            fund_address: "fund",
            owner_address: "owner",
            balance_nano: "0",
          }),
          stderr: "",
        })
    );

    expect(existsSync(walletPath())).toBe(true);
    await gocoonInit();

    expect(mode(walletPath())).toBe(0o600);
  });
});
