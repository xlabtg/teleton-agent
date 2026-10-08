/**
 * TON Proxy manager — downloads, starts, stops the Tonutils-Proxy binary.
 *
 * Binary source: https://github.com/xssnick/Tonutils-Proxy
 * The CLI binary exposes an HTTP proxy on 127.0.0.1:<port> for .ton sites.
 */

import { spawn, spawnSync, type ChildProcess } from "child_process";
import {
  existsSync,
  chmodSync,
  createWriteStream,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { mkdir, unlink as unlinkAsync } from "fs/promises";
import { createServer } from "node:net";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";
import { createLogger } from "../utils/logger.js";
import { TELETON_ROOT } from "../workspace/paths.js";
import type { TonProxyConfig } from "../config/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Maximum allowed binary size (50 MB) */
const MAX_BINARY_BYTES = 50 * 1024 * 1024;
/** Only allow downloads from the official GitHub domain */
const ALLOWED_DOWNLOAD_HOST = "objects.githubusercontent.com";
const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
const BINARY_NAME_PATTERN =
  /^tonutils-proxy-cli-(?:darwin|linux|windows)-(?:amd64|arm64)(?:\.exe)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

const log = createLogger("TonProxy");

const GITHUB_REPO = "xssnick/Tonutils-Proxy";
const BINARY_DIR = join(TELETON_ROOT, "bin");
const PID_FILE = join(TELETON_ROOT, "ton-proxy.pid");
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 5_000;

export class TonProxyManager {
  private process: ChildProcess | null = null;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private config: TonProxyConfig;
  private restartCount = 0;
  private maxRestarts = 3;

  constructor(config: TonProxyConfig) {
    this.config = config;
  }

  /** Resolve the binary path — user-specified or auto-detected */
  getBinaryPath(): string {
    if (this.config.binary_path) return this.config.binary_path;
    return join(BINARY_DIR, getBinaryName());
  }

  /** Check if the binary exists on disk */
  isInstalled(): boolean {
    return existsSync(this.getBinaryPath());
  }

  /** Whether the proxy process is currently running */
  isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  /**
   * Download the pinned CLI binary from GitHub releases and verify its SHA-256 checksum.
   * The release tag and expected digests are loaded from checksums.json next to this file.
   * On any failure the partially-written file is deleted and no auto-retry is performed.
   */
  async install(): Promise<void> {
    const binaryName = getBinaryName();
    log.info(`Downloading TON Proxy binary (${binaryName})...`);

    // Load pinned release metadata — fail fast if the file is missing or malformed
    const checksumPath = join(__dirname, "checksums.json");
    let checksumData: { tag: string; binaries: Record<string, string> };
    try {
      checksumData = JSON.parse(readFileSync(checksumPath, "utf-8")) as typeof checksumData;
    } catch {
      throw new Error(`Cannot read checksum manifest: ${checksumPath}`);
    }

    const expectedDigest = checksumData.binaries[binaryName];
    if (
      !BINARY_NAME_PATTERN.test(binaryName) ||
      !RELEASE_TAG_PATTERN.test(checksumData.tag) ||
      !expectedDigest ||
      !SHA256_PATTERN.test(expectedDigest)
    ) {
      throw new Error(
        `No checksum for binary "${binaryName}" in checksums.json. ` +
          `Supported binaries: ${Object.keys(checksumData.binaries).join(", ")}`
      );
    }

    const tag = checksumData.tag;
    await mkdir(BINARY_DIR, { recursive: true });

    // Build the download URL for the pinned tag
    const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${binaryName}`;
    log.info(`Downloading ${downloadUrl} (${tag})`);

    // codeql[js/file-access-to-http] The release tag, binary name, and digest come from a bundled manifest and are regex-validated before building this URL.
    const res = await fetch(downloadUrl);
    if (!res.ok || !res.body) {
      throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    }

    // Validate that redirects stayed within GitHub's CDN domain
    const finalUrl = new URL(res.url);
    if (finalUrl.hostname !== "github.com" && finalUrl.hostname !== ALLOWED_DOWNLOAD_HOST) {
      throw new Error(`Download was redirected to an unexpected host: ${finalUrl.hostname}`);
    }

    // Validate Content-Length before streaming
    const contentLength = res.headers.get("content-length");
    if (contentLength !== null) {
      const bytes = parseInt(contentLength, 10);
      if (!Number.isFinite(bytes) || bytes > MAX_BINARY_BYTES) {
        throw new Error(`Unexpected Content-Length ${bytes} bytes (max ${MAX_BINARY_BYTES})`);
      }
    }

    const dest = this.getBinaryPath();
    let bytesWritten = 0;
    const hash = createHash("sha256");
    const fileStream = createWriteStream(dest);

    try {
      // Stream the body through a byte-counter + hash accumulator into the file
      const body = res.body as unknown as AsyncIterable<Uint8Array>;

      // codeql[js/http-to-file-access] The proxy binary is size-capped during streaming and verified against the pinned SHA-256 digest before chmod.
      await pipeline(
        body,
        async function* (source) {
          for await (const chunk of source) {
            bytesWritten += chunk.length;
            if (bytesWritten > MAX_BINARY_BYTES) {
              throw new Error(`Binary exceeds maximum allowed size of ${MAX_BINARY_BYTES} bytes`);
            }
            hash.update(chunk);
            yield chunk;
          }
        },
        fileStream
      );
    } catch (err) {
      // Remove partial file before propagating — never leave an unverified file on disk
      try {
        unlinkSync(dest);
      } catch {
        /* ignore */
      }
      throw err;
    }

    // Verify SHA-256 digest
    const actualDigest = hash.digest("hex");
    if (actualDigest !== expectedDigest) {
      try {
        unlinkSync(dest);
      } catch {
        /* ignore */
      }
      throw new Error(
        `Checksum mismatch for ${binaryName}!\n` +
          `  expected: ${expectedDigest}\n` +
          `  actual:   ${actualDigest}\n` +
          `The downloaded file has been deleted. Do NOT retry automatically.`
      );
    }

    // Only make executable after successful checksum verification
    chmodSync(dest, 0o755);

    log.info(`TON Proxy installed: ${dest} (${tag}) — checksum OK`);
  }

  /** Refuse occupied ports; a stale PID is never proof of process ownership. */
  private killOrphan(): void {
    this.removePidFile();
    const result = spawnSync("ss", ["-H", "-ltn", `sport = :${this.config.port}`], {
      encoding: "utf-8",
      timeout: 3000,
    });
    if (result.status === 0 && result.stdout.trim()) {
      throw new Error(
        `TON Proxy port ${this.config.port} is in use; stop its owner before starting the proxy`
      );
    }
  }

  /** Write PID to file for orphan detection */
  private writePidFile(pid: number): void {
    try {
      writeFileSync(PID_FILE, String(pid), { mode: 0o600 });
    } catch {
      log.warn("Failed to write TON Proxy PID file");
    }
  }

  /** Remove PID file */
  private removePidFile(): void {
    try {
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
  }

  /** Start the proxy process */
  async start(): Promise<void> {
    if (this.isRunning()) {
      log.warn("TON Proxy is already running");
      return;
    }

    // Reset restart counter for fresh start
    this.restartCount = 0;
    this.maxRestarts = 3;

    // Do not trust stale PID files or signal unrelated processes.
    this.killOrphan();
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", (error) =>
        reject(
          new Error(`TON Proxy port ${this.config.port} is unavailable/in use`, { cause: error })
        )
      );
      probe.listen(this.config.port, "127.0.0.1", () =>
        probe.close((error) => (error ? reject(error) : resolve()))
      );
    });

    if (!this.isInstalled()) {
      await this.install();
    }

    const binaryPath = this.getBinaryPath();
    const port = String(this.config.port);

    log.info(`Starting TON Proxy on 127.0.0.1:${port}`);

    this.process = spawn(binaryPath, ["-addr", `127.0.0.1:${port}`], {
      cwd: BINARY_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    this.process.stdout?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) log.debug(`[proxy] ${line}`);
    });

    this.process.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) log.warn(`[proxy:err] ${line}`);
    });

    this.process.on("exit", (code, signal) => {
      log.info(`TON Proxy exited (code=${code}, signal=${signal})`);
      this.process = null;
      this.removePidFile();

      // Auto-restart on unexpected exit (up to maxRestarts)
      if (code !== 0 && code !== null && this.restartCount < this.maxRestarts) {
        this.restartCount++;
        log.warn(`Auto-restarting TON Proxy (attempt ${this.restartCount}/${this.maxRestarts})`);
        // Fire-and-forget restart
        this.start().catch((err) => log.error({ err }, "Failed to auto-restart TON Proxy"));
      }
    });

    this.process.on("error", (err) => {
      log.error({ err }, "TON Proxy process error");
      this.process = null;
    });

    // Start health check loop
    this.startHealthCheck();

    // Wait briefly for process to crash or start
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.isRunning()) {
          resolve();
        } else {
          reject(new Error("TON Proxy process exited immediately"));
        }
      }, 1000);

      this.process?.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("TON Proxy process exited during startup"));
      });
    });

    if (this.process?.pid) this.writePidFile(this.process.pid);
    log.info(`TON Proxy running on 127.0.0.1:${port} (PID ${this.process?.pid})`);
  }

  /** Stop the proxy process gracefully */
  async stop(): Promise<void> {
    this.stopHealthCheck();

    if (!this.process) return;

    // Prevent auto-restart during intentional stop
    this.maxRestarts = 0;

    log.info("Stopping TON Proxy...");

    return new Promise<void>((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      const forceKill = setTimeout(() => {
        if (this.process) {
          log.warn("TON Proxy did not exit gracefully, sending SIGKILL");
          this.process.kill("SIGKILL");
        }
      }, KILL_GRACE_MS);

      this.process.on("exit", () => {
        clearTimeout(forceKill);
        this.process = null;
        this.removePidFile();
        resolve();
      });

      this.process.kill("SIGTERM");
    });
  }

  /** Remove the downloaded binary from disk */
  async uninstall(): Promise<void> {
    if (this.isRunning()) {
      await this.stop();
    }
    const binaryPath = this.getBinaryPath();
    if (existsSync(binaryPath)) {
      await unlinkAsync(binaryPath);
      log.info(`TON Proxy binary removed: ${binaryPath}`);
    }
  }

  /** Get proxy status for WebUI / tools */
  getStatus(): { running: boolean; port: number; installed: boolean; pid?: number } {
    return {
      running: this.isRunning(),
      port: this.config.port,
      installed: this.isInstalled(),
      pid: this.process?.pid,
    };
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthInterval = setInterval(() => {
      void this.checkHealth();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  private async checkHealth(): Promise<void> {
    if (!this.isRunning()) return;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
      // Tonutils-Proxy responds to regular HTTP requests when used as proxy
      // A simple connect to the port verifies it's alive
      const res = await fetch(`http://127.0.0.1:${this.config.port}/`, {
        signal: controller.signal,
      }).catch(() => null);
      clearTimeout(timeout);

      if (!res) {
        log.warn("TON Proxy health check failed (no response)");
      }
    } catch {
      // Connection refused is normal for proxy (no upstream) — process liveness is the real check
    }
  }
}

/** Get the platform-specific binary name */
function getBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  let os: string;
  switch (platform) {
    case "linux":
      os = "linux";
      break;
    case "darwin":
      os = "darwin";
      break;
    case "win32":
      os = "windows";
      break;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }

  let cpuArch: string;
  switch (arch) {
    case "x64":
      cpuArch = "amd64";
      break;
    case "arm64":
      cpuArch = "arm64";
      break;
    default:
      throw new Error(`Unsupported architecture: ${arch}`);
  }

  const ext = platform === "win32" ? ".exe" : "";
  return `tonutils-proxy-cli-${os}-${cpuArch}${ext}`;
}
