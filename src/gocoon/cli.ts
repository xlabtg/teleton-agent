import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { chmodSync, existsSync, mkdirSync } from "fs";
import { createLogger } from "../utils/logger.js";
import { fetchWithTimeout } from "../utils/fetch.js";
import { ensureGocoonBinaries } from "./installer.js";
import {
  clientConfigPath,
  gocoonDataDir,
  runnerBaseUrl,
  tonConfigPath,
  walletPath,
} from "./paths.js";

const log = createLogger("gocoon");
const execFileAsync = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// Run a gocoon subcommand and capture stdout (for --json / short commands).
export async function runGocoon(args: string[], timeoutMs = 60_000): Promise<string> {
  const { gocoon } = await ensureGocoonBinaries();
  const { stdout } = await execFileAsync(gocoon, args, {
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

// Run a long-running gocoon subcommand, forwarding output lines. Resolves on exit 0.
export async function streamGocoon(args: string[], onLine?: (line: string) => void): Promise<void> {
  const { gocoon } = await ensureGocoonBinaries();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(gocoon, args, { stdio: ["ignore", "pipe", "pipe"] });
    const emit = (buf: Buffer): void => {
      const line = buf.toString().trimEnd();
      if (line) (onLine ?? ((l) => log.debug(l)))(line);
    };
    child.stdout?.on("data", emit);
    child.stderr?.on("data", emit);
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`gocoon ${args[0]} exited with code ${code ?? "null"}`))
    );
  });
}

function parseJson(out: string): Record<string, unknown> {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw new Error(`gocoon: expected JSON output, got: ${out.slice(0, 200)}`);
  }
  return JSON.parse(out.slice(start, end + 1)) as Record<string, unknown>;
}

export interface InitSummary {
  fundAddress: string;
  ownerAddress: string;
  recommendedFundingTon: string;
  recommendedFundingNano: string;
  walletPath: string;
  configPath: string;
}

export function walletExists(): boolean {
  return existsSync(walletPath()) && existsSync(clientConfigPath());
}

function hardenGocoonDataPermissions(): void {
  mkdirSync(gocoonDataDir(), { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(gocoonDataDir(), PRIVATE_DIR_MODE);
  if (existsSync(walletPath())) chmodSync(walletPath(), PRIVATE_FILE_MODE);
}

// Create the COCOON wallet, or reuse the existing one (stable funding address).
export async function gocoonInit(): Promise<InitSummary> {
  hardenGocoonDataPermissions();
  if (walletExists()) {
    const info = await walletInfo();
    return {
      fundAddress: info.fundAddress,
      ownerAddress: info.ownerAddress,
      recommendedFundingTon: info.recommendedFundingTon,
      recommendedFundingNano: "",
      walletPath: walletPath(),
      configPath: clientConfigPath(),
    };
  }
  const j = parseJson(
    await runGocoon(["init", "--dir", gocoonDataDir(), "--json", "--force"], 120_000)
  );
  hardenGocoonDataPermissions();
  return {
    fundAddress: String(j.fund_address ?? ""),
    ownerAddress: String(j.owner_address ?? ""),
    recommendedFundingTon: String(j.recommended_funding_ton ?? "20"),
    recommendedFundingNano: String(j.recommended_funding_nano ?? "20000000000"),
    walletPath: String(j.wallet_path ?? walletPath()),
    configPath: String(j.config_path ?? clientConfigPath()),
  };
}

export interface WalletInfo {
  ownerAddress: string;
  fundAddress: string;
  balanceNano: bigint;
  balanceTon: string;
  funded: boolean;
  recommendedFundingTon: string;
}

export async function walletInfo(): Promise<WalletInfo> {
  const j = parseJson(
    await runGocoon([
      "wallet",
      "info",
      "--wallet",
      walletPath(),
      "--config",
      clientConfigPath(),
      "--json",
    ])
  );
  return {
    ownerAddress: String(j.owner_address ?? ""),
    fundAddress: String(j.fund_address ?? ""),
    balanceNano: BigInt(String(j.balance_nano ?? "0")),
    balanceTon: String(j.balance_ton ?? "0"),
    funded: Boolean(j.funded),
    recommendedFundingTon: String(j.recommended_funding_ton ?? "20"),
  };
}

export interface ChannelInfo {
  stateName: string;
  stakeNano: bigint;
  balanceNano: bigint;
}

// Read a channel's on-chain state directly (no runner needed). The contract
// account stays "active" after a cooperative close (it keeps a little storage
// TON), so callers must check stateName, not the account status, to tell a
// closed channel from a live one. Returns null if it can't be read.
export async function channelInfoOnChain(clientSC: string): Promise<ChannelInfo | null> {
  try {
    const j = parseJson(
      await runGocoon([
        "channel",
        "info",
        "--client-sc",
        clientSC,
        "--config",
        clientConfigPath(),
        "--ton-config",
        tonConfigPath(),
        "--json",
      ])
    );
    return {
      stateName: String(j.state_name ?? ""),
      stakeNano: BigInt(String(j.stake_nano ?? "0")),
      balanceNano: BigInt(String(j.balance_nano ?? "0")),
    };
  } catch {
    return null;
  }
}

export async function waitFunded(onLine?: (line: string) => void): Promise<void> {
  await streamGocoon(
    ["wallet", "wait-funded", "--wallet", walletPath(), "--config", clientConfigPath()],
    onLine
  );
}

// Read the active proxy's client_sc from the running runner. Needed by topup/close.
export async function fetchClientSC(port: number): Promise<string> {
  const res = await fetchWithTimeout(`${runnerBaseUrl(port)}/jsonstats`, { timeoutMs: 3_000 });
  if (!res.ok) {
    throw new Error(`runner /jsonstats returned HTTP ${res.status} (is the gocoon runner active?)`);
  }
  const j = (await res.json()) as { proxies?: { sc_address?: string }[] };
  const addr = j.proxies?.[0]?.sc_address?.trim();
  if (!addr) throw new Error("runner has no proxy/client_sc yet; wait for discovery and retry");
  return addr;
}

// Decimal TON string to integer nanoTON (max 9 decimals).
export function tonToNano(ton: string): string {
  const s = ton.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error(`invalid TON amount: "${ton}"`);
  const [int, frac = ""] = s.split(".");
  return (BigInt(int) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"))).toString();
}
