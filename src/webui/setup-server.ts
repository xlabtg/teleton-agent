/**
 * Setup WebUI Server
 *
 * Lightweight Hono server for the setup wizard.
 * Runs on port 7777 (localhost-only), no auth needed.
 * Pattern: simplified version of src/webui/server.ts.
 */

import { Hono } from "hono";
import type { ServerType } from "@hono/node-server";
import { cors } from "hono/cors";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { createSetupRoutes } from "./routes/setup.js";
import { applySecurityMiddleware, sharedBodyLimit } from "./http-common.js";
import { findWebDist, createStaticHandler } from "./static-serving.js";
import { startHonoServer, stopHonoServer } from "../utils/http-server.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import YAML from "yaml";
import { TELETON_ROOT } from "../workspace/paths.js";
import type { Context } from "hono";
import { createLogger } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";
import { hashToken } from "./middleware/token-hash.js";

const log = createLogger("Setup");

/** Max requests per window per client to /api/setup/launch. */
const LAUNCH_RATE_LIMIT_MAX = 5;
/** Rolling window for the launch rate limiter. */
const LAUNCH_RATE_LIMIT_WINDOW_MS = 60_000;
/** Header used to present the bootstrap nonce. */
export const SETUP_NONCE_HEADER = "X-Setup-Nonce";

function clientKey(c: Context): string {
  // `@hono/node-server` exposes the raw socket via c.env.incoming
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  return incoming?.socket?.remoteAddress || "unknown";
}

function nonceMatches(provided: string | undefined | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function autoOpenBrowser(url: string): void {
  const os = platform();
  let prog: string;

  if (os === "darwin") {
    prog = "open";
  } else if (os === "win32") {
    prog = "explorer";
  } else {
    prog = "xdg-open";
  }

  const child = spawn(prog, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {
    log.info(`Open this URL in your browser: ${url}`);
  });
  child.unref();
}

export class SetupServer {
  private app: Hono;
  private server: ServerType | null = null;
  private launchResolve: ((token: string) => void) | null = null;
  private launchPromise: Promise<string>;
  /** One-time bootstrap nonce — required to call POST /api/setup/launch. */
  private readonly nonce: string;
  /** Flipped true after a successful launch. No further launches are accepted. */
  private launchConsumed = false;
  /** In-process rate limiter state for the launch endpoint, keyed by client IP. */
  private readonly launchAttempts = new Map<string, number[]>();

  constructor(private port: number = 7777) {
    this.app = new Hono();
    this.nonce = randomBytes(32).toString("hex");
    this.launchPromise = new Promise<string>((resolve) => {
      this.launchResolve = resolve;
    });
    this.setupMiddleware();
    this.setupRoutes();
    this.setupStaticServing();
  }

  /** Returns the bootstrap nonce so the CLI can print it / embed it in the launch URL. */
  getNonce(): string {
    return this.nonce;
  }

  /** Returns a promise that resolves with the auth token when the user clicks "Start Agent" */
  waitForLaunch(): Promise<string> {
    return this.launchPromise;
  }

  /**
   * Record an attempt and return true if the caller is within the rate limit.
   * Uses a simple sliding-window counter keyed by client IP.
   */
  private checkRateLimit(key: string): boolean {
    const now = Date.now();
    const cutoff = now - LAUNCH_RATE_LIMIT_WINDOW_MS;
    const history = this.launchAttempts.get(key) ?? [];
    const recent = history.filter((ts) => ts > cutoff);
    recent.push(now);
    this.launchAttempts.set(key, recent);
    return recent.length <= LAUNCH_RATE_LIMIT_MAX;
  }

  private setupMiddleware(): void {
    // CORS alone does not prevent a browser from executing a cross-site request.
    this.app.use("*", async (c, next) => {
      const url = new URL(c.req.url);
      const host = c.req.header("Host") ?? url.host;
      const hosts = new Set([`localhost:${this.port}`, `127.0.0.1:${this.port}`]);
      const origin = c.req.header("Origin");
      const origins = new Set(
        [...hosts]
          .map((h) => `http://${h}`)
          .concat(["http://localhost:5173", "http://127.0.0.1:5173"])
      );
      if (!hosts.has(host.toLowerCase()) || (origin && !origins.has(origin))) {
        return c.json({ success: false, error: "Forbidden setup origin or host" }, 403);
      }
      if (
        ["POST", "PUT", "PATCH"].includes(c.req.method) &&
        !/^application\/json(?:;|$)/i.test(c.req.header("Content-Type") ?? "")
      ) {
        return c.json({ success: false, error: "Setup requires application/json" }, 415);
      }
      await next();
    });
    // CORS for localhost
    this.app.use(
      "*",
      cors({
        origin: [
          "http://localhost:5173",
          `http://localhost:${this.port}`,
          "http://127.0.0.1:5173",
          `http://127.0.0.1:${this.port}`,
        ],
        credentials: true,
        allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"],
        allowHeaders: ["Content-Type", SETUP_NONCE_HEADER],
        maxAge: 3600,
      })
    );

    // Body size limit
    this.app.use(
      "*",
      sharedBodyLimit((c) =>
        c.json({ success: false, error: "Request body too large (max 2MB)" }, 413)
      )
    );

    // Security headers
    applySecurityMiddleware(this.app, { referrerPolicy: "strict-origin-when-cross-origin" });

    // No auth middleware — localhost-only setup server
  }

  private setupRoutes(): void {
    // Health check
    this.app.get("/health", (c) => c.json({ status: "ok" }));

    // Mount setup routes
    this.app.route("/api/setup", createSetupRoutes());

    // Auth check — setup server is NOT authenticated, return a distinguishable response
    // so pollHealth can tell setup server apart from the real agent WebUI
    this.app.get("/auth/check", (c) =>
      c.json({ success: true, data: { authenticated: false, setup: true } })
    );

    // Launch endpoint — generates the auth token, hashes it into config.yaml,
    // and resolves the launch promise. Gated by a one-time bootstrap nonce and
    // a small rate limiter (see AUDIT-H7).
    this.app.post("/api/setup/launch", async (c) => {
      // 1. Rate limit first, before any work — malicious callers should not be
      // able to burn CPU on nonce comparisons or hashing.
      const key = clientKey(c);
      if (!this.checkRateLimit(key)) {
        const retryAfter = Math.ceil(LAUNCH_RATE_LIMIT_WINDOW_MS / 1000);
        return c.json(
          {
            success: false,
            error: `Too many launch attempts. Try again in ${retryAfter}s.`,
          },
          429,
          { "Retry-After": String(retryAfter) }
        );
      }

      // 2. Once a launch has succeeded, no further launches are accepted —
      // a second caller could otherwise rotate the token out from under the
      // legitimate user.
      if (this.launchConsumed) {
        return c.json(
          {
            success: false,
            error: "Setup already launched — restart `teleton setup --ui` to retry.",
          },
          409
        );
      }

      // 3. Validate the bootstrap nonce. Check header first (preferred),
      // then JSON body as a fallback for clients that can't set headers.
      let provided = c.req.header(SETUP_NONCE_HEADER);
      if (!provided) {
        try {
          const body = (await c.req.json().catch(() => null)) as { nonce?: unknown } | null;
          if (body && typeof body.nonce === "string") provided = body.nonce;
        } catch {
          // no body — fall through to 401
        }
      }
      if (!nonceMatches(provided, this.nonce)) {
        return c.json({ success: false, error: "Invalid or missing setup nonce" }, 401);
      }

      try {
        // Generate auth token — returned once to the client, never persisted in plaintext.
        const token = randomBytes(32).toString("hex");
        const tokenHash = hashToken(token);

        // Persist hashed token into config.yaml. We explicitly delete any
        // legacy `auth_token` so a prior plaintext value does not linger.
        const configPath = join(TELETON_ROOT, "config.yaml");
        const raw = readFileSync(configPath, "utf-8");
        const config = YAML.parse(raw) ?? {};
        const webui = { ...(config.webui || {}) };
        delete webui.auth_token;
        webui.enabled = true;
        webui.auth_token_hash = tokenHash;
        config.webui = webui;
        writeFileSync(configPath, YAML.stringify(config), { encoding: "utf-8", mode: 0o600 });

        // Mark launch consumed so no second caller can rotate the token.
        this.launchConsumed = true;
        log.info("Launch requested — auth token generated");

        // Resolve the launch promise AFTER the response is sent — otherwise
        // server.stop() kills the connection before the client gets the token
        const resolve = this.launchResolve;
        this.launchResolve = null;
        if (resolve) {
          setTimeout(() => resolve(token), 500);
        }

        return c.json({ success: true, data: { token } });
      } catch (error: unknown) {
        return c.json({ success: false, error: getErrorMessage(error) }, 500);
      }
    });

    // Error handler
    this.app.onError((err, c) => {
      log.error({ err }, "Setup server error");
      return c.json({ success: false, error: err.message || "Internal server error" }, 500);
    });
  }

  private setupStaticServing(): void {
    const webDist = findWebDist();
    if (!webDist) {
      log.warn(
        "Web UI build not found (dist/web/index.html missing) — run `npm run build:web` to build the frontend"
      );
      return;
    }
    log.info(`Serving UI from: ${webDist}`);
    this.app.get("*", createStaticHandler(webDist, { async: false }));
  }

  async start(openUrl?: string): Promise<void> {
    this.server = await startHonoServer({
      fetch: this.app.fetch,
      hostname: "127.0.0.1",
      port: this.port,
      onListen: () => {
        const url = openUrl ?? `http://localhost:${this.port}/setup`;
        log.info(`Setup wizard: ${url}`);
        autoOpenBrowser(url);
      },
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await stopHonoServer(this.server);
      log.info("Setup server stopped");
    }
  }
}
