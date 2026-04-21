import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { Server as HttpServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebUIServerDeps } from "./types.js";
import type { StateChangeEvent } from "../agent/lifecycle.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("WebUI");
import {
  generateToken,
  maskToken,
  safeCompare,
  COOKIE_NAME,
  COOKIE_MAX_AGE,
} from "./middleware/auth.js";
import { createCsrfMiddleware } from "./middleware/csrf.js";
import { logInterceptor } from "./log-interceptor.js";
import { createStatusRoutes } from "./routes/status.js";
import { createToolsRoutes } from "./routes/tools.js";
import { createLogsRoutes } from "./routes/logs.js";
import { createMemoryRoutes } from "./routes/memory.js";
import { createSoulRoutes } from "./routes/soul.js";
import { createPluginsRoutes } from "./routes/plugins.js";
import { createMcpRoutes } from "./routes/mcp.js";
import { createWorkspaceRoutes } from "./routes/workspace.js";
import { createTasksRoutes } from "./routes/tasks.js";
import { createConfigRoutes } from "./routes/config.js";
import { createMarketplaceRoutes } from "./routes/marketplace.js";
import { createHooksRoutes } from "./routes/hooks.js";
import { createGroqRoutes } from "./routes/groq.js";
import { createTonProxyRoutes } from "./routes/ton-proxy.js";
import { createMtprotoRoutes } from "./routes/mtproto.js";
import { createNotificationsRoutes, notificationBus } from "./routes/notifications.js";
import { getNotificationService } from "../services/notifications.js";
import { createCacheRoutes } from "./routes/cache.js";
import { createAgentActionsRoutes } from "./routes/agent-actions.js";
import { createMetricsRoutes } from "./routes/metrics.js";
import { createSessionsRoutes } from "./routes/sessions.js";
import { createAnalyticsRoutes } from "./routes/analytics.js";
import { createSecurityRoutes } from "./routes/security.js";
import { createAuditMiddleware } from "./middleware/audit.js";
import { createHealthRoutes } from "./routes/health.js";
import { createExportImportRoutes } from "./routes/export-import.js";
import { createWorkflowsRoutes } from "./routes/workflows.js";
import { createSelfImprovementRoutes } from "./routes/self-improvement.js";
import { registerAutonomousRoutes } from "./routes/autonomous.js";

function findWebDist(): string | null {
  // Try common locations relative to CWD (where teleton is launched from)
  const candidates = [
    resolve("dist/web"), // npm start / teleton start (from project root)
    resolve("web"), // fallback
  ];
  // Also try relative to the compiled file
  const __dirname = dirname(fileURLToPath(import.meta.url));
  candidates.push(
    resolve(__dirname, "web"), // dist/web when __dirname = dist/
    resolve(__dirname, "../dist/web") // when running with tsx from src/
  );

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return null;
}

export class WebUIServer {
  private app: Hono;
  private server: ReturnType<typeof serve> | null = null;
  private deps: WebUIServerDeps;
  private authToken: string;

  constructor(deps: WebUIServerDeps) {
    this.deps = deps;
    this.app = new Hono();

    // Generate or use configured auth token
    this.authToken = deps.config.auth_token || generateToken();

    this.setupMiddleware();
    this.setupRoutes();
    this.setupNotificationTriggers();
  }

  /** Set an HttpOnly session cookie */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono context type
  private setSessionCookie(c: any): void {
    setCookie(c, COOKIE_NAME, this.authToken, {
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
      secure: false, // localhost is HTTP
      maxAge: COOKIE_MAX_AGE,
    });
  }

  private setupMiddleware() {
    // CORS - must be first
    this.app.use(
      "*",
      cors({
        origin: this.deps.config.cors_origins,
        credentials: true,
        allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"],
        allowHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
        maxAge: 3600,
      })
    );

    // CSRF protection (double-submit cookie pattern)
    // Must come after CORS (which handles preflight) but before auth.
    this.app.use("*", createCsrfMiddleware());

    // Request logging (if enabled)
    if (this.deps.config.log_requests) {
      this.app.use("*", async (c, next) => {
        const start = Date.now();
        await next();
        const duration = Date.now() - start;
        log.info(`${c.req.method} ${c.req.path} → ${c.res.status} (${duration}ms)`);
      });
    }

    // Body size limit (defense-in-depth against oversized payloads)
    this.app.use(
      "*",
      bodyLimit({
        maxSize: 2 * 1024 * 1024, // 2MB
        onError: (c) => c.json({ success: false, error: "Request body too large (max 2MB)" }, 413),
      })
    );

    // Security headers for all responses
    this.app.use("*", async (c, next) => {
      await next();
      c.res.headers.set("X-Content-Type-Options", "nosniff");
      c.res.headers.set("X-Frame-Options", "DENY");
      c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    });

    // Auth for all /api/* routes
    // Accepts: HttpOnly cookie > Bearer header > ?token= query param (fallback)
    this.app.use("/api/*", async (c, next) => {
      // 1. Check HttpOnly session cookie (primary — browser)
      const cookieToken = getCookie(c, COOKIE_NAME);
      if (cookieToken && safeCompare(cookieToken, this.authToken)) {
        return next();
      }

      // 2. Check Authorization header (secondary — API/curl)
      const authHeader = c.req.header("Authorization");
      if (authHeader) {
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (match && safeCompare(match[1], this.authToken)) {
          return next();
        }
      }

      // 3. Check ?token= query param (fallback — backward compat)
      const queryToken = c.req.query("token");
      if (queryToken && safeCompare(queryToken, this.authToken)) {
        return next();
      }

      return c.json({ success: false, error: "Unauthorized" }, 401);
    });

    // Audit logging for mutating API requests (after auth, so unauthenticated requests are not logged)
    this.app.use("/api/*", createAuditMiddleware(this.deps));
  }

  private setupRoutes() {
    // Health check (no auth)
    this.app.get("/health", (c) => c.json({ status: "ok" }));

    // === Auth routes (no auth required) ===

    // Token exchange: browser opens with ?token=, gets HttpOnly cookie, redirects to /
    this.app.get("/auth/exchange", (c) => {
      const token = c.req.query("token");
      if (!token || !safeCompare(token, this.authToken)) {
        return c.json({ success: false, error: "Invalid token" }, 401);
      }

      this.setSessionCookie(c);
      return c.redirect("/");
    });

    // Manual login: POST with token, get cookie
    this.app.post("/auth/login", async (c) => {
      try {
        const body = await c.req.json<{ token: string }>();
        if (!body.token || !safeCompare(body.token, this.authToken)) {
          return c.json({ success: false, error: "Invalid token" }, 401);
        }

        this.setSessionCookie(c);
        return c.json({ success: true });
      } catch {
        return c.json({ success: false, error: "Invalid request body" }, 400);
      }
    });

    // Logout: clear cookie
    this.app.post("/auth/logout", (c) => {
      deleteCookie(c, COOKIE_NAME, { path: "/" });
      return c.json({ success: true });
    });

    // Check auth status (no auth required — returns whether cookie is valid)
    this.app.get("/auth/check", (c) => {
      const cookieToken = getCookie(c, COOKIE_NAME);
      const authenticated = !!(cookieToken && safeCompare(cookieToken, this.authToken));
      return c.json({ success: true, data: { authenticated } });
    });

    // API routes (all require auth via middleware above)
    this.app.route("/api/status", createStatusRoutes(this.deps));
    this.app.route("/api/tools", createToolsRoutes(this.deps));
    this.app.route("/api/logs", createLogsRoutes(this.deps));
    this.app.route("/api/memory", createMemoryRoutes(this.deps));
    this.app.route("/api/soul", createSoulRoutes(this.deps));
    this.app.route("/api/plugins", createPluginsRoutes(this.deps));
    this.app.route("/api/mcp", createMcpRoutes(this.deps));
    this.app.route("/api/workspace", createWorkspaceRoutes(this.deps));
    this.app.route("/api/tasks", createTasksRoutes(this.deps));
    this.app.route("/api/config", createConfigRoutes(this.deps));
    this.app.route("/api/marketplace", createMarketplaceRoutes(this.deps));
    this.app.route("/api/hooks", createHooksRoutes(this.deps));
    this.app.route("/api/groq", createGroqRoutes(this.deps));
    this.app.route("/api/ton-proxy", createTonProxyRoutes(this.deps));
    this.app.route("/api/mtproto", createMtprotoRoutes(this.deps));
    this.app.route("/api/notifications", createNotificationsRoutes(this.deps));
    this.app.route("/api/cache", createCacheRoutes(this.deps));
    this.app.route("/api/agent-actions", createAgentActionsRoutes(this.deps));
    this.app.route("/api/metrics", createMetricsRoutes(this.deps));
    this.app.route("/api/sessions", createSessionsRoutes(this.deps));
    this.app.route("/api/analytics", createAnalyticsRoutes(this.deps));
    this.app.route("/api/security", createSecurityRoutes(this.deps));
    this.app.route("/api/health-check", createHealthRoutes(this.deps));
    this.app.route("/api/export", createExportImportRoutes(this.deps));
    this.app.route("/api/workflows", createWorkflowsRoutes(this.deps));
    this.app.route("/api/self-improvement", createSelfImprovementRoutes(this.deps));
    registerAutonomousRoutes(this.app);

    // Debug endpoint — returns build metadata (which dist folder is served and its version)
    this.app.get("/api/debug/ui-version", (c) => {
      const webDist = findWebDist();
      let buildVersion: string | null = null;
      let buildTimestamp: string | null = null;

      if (webDist) {
        try {
          const meta = JSON.parse(readFileSync(join(webDist, "build-meta.json"), "utf-8"));
          buildVersion = meta.version ?? null;
          buildTimestamp = meta.buildTimestamp ?? null;
        } catch {
          // build-meta.json not present in older builds — acceptable
        }
      }

      return c.json({
        success: true,
        data: {
          webDistPath: webDist,
          buildVersion,
          buildTimestamp,
          nodeVersion: process.version,
          uptime: Math.floor(process.uptime()),
        },
      });
    });

    // Agent lifecycle routes
    this.app.post("/api/agent/start", async (c) => {
      const lifecycle = this.deps.lifecycle;
      if (!lifecycle) {
        return c.json({ error: "Agent lifecycle not available" }, 503);
      }
      const state = lifecycle.getState();
      if (state === "running") {
        return c.json({ state: "running" }, 409);
      }
      if (state === "stopping") {
        return c.json({ error: "Agent is currently stopping, please wait" }, 409);
      }
      // Fire-and-forget: start is async, we return immediately
      lifecycle.start().catch((err: Error) => {
        log.error({ err }, "Agent start failed");
      });
      return c.json({ state: "starting" });
    });

    this.app.post("/api/agent/stop", async (c) => {
      const lifecycle = this.deps.lifecycle;
      if (!lifecycle) {
        return c.json({ error: "Agent lifecycle not available" }, 503);
      }
      const state = lifecycle.getState();
      if (state === "stopped") {
        return c.json({ state: "stopped" }, 409);
      }
      if (state === "starting") {
        return c.json({ error: "Agent is currently starting, please wait" }, 409);
      }
      // Fire-and-forget: stop is async, we return immediately
      lifecycle.stop().catch((err: Error) => {
        log.error({ err }, "Agent stop failed");
      });
      return c.json({ state: "stopping" });
    });

    this.app.get("/api/agent/status", (c) => {
      const lifecycle = this.deps.lifecycle;
      if (!lifecycle) {
        return c.json({ error: "Agent lifecycle not available" }, 503);
      }
      return c.json({
        state: lifecycle.getState(),
        uptime: lifecycle.getUptime(),
        error: lifecycle.getError() ?? null,
      });
    });

    this.app.get("/api/agent/events", (c) => {
      const lifecycle = this.deps.lifecycle;
      if (!lifecycle) {
        return c.json({ error: "Agent lifecycle not available" }, 503);
      }

      return streamSSE(c, async (stream) => {
        let aborted = false;

        stream.onAbort(() => {
          aborted = true;
        });

        // Push current state immediately on connection
        const now = Date.now();
        await stream.writeSSE({
          event: "status",
          id: String(now),
          data: JSON.stringify({
            state: lifecycle.getState(),
            error: lifecycle.getError() ?? null,
            timestamp: now,
          }),
          retry: 3000,
        });

        // Listen for state changes
        const onStateChange = (event: StateChangeEvent) => {
          if (aborted) return;
          void stream.writeSSE({
            event: "status",
            id: String(event.timestamp),
            data: JSON.stringify({
              state: event.state,
              error: event.error ?? null,
              timestamp: event.timestamp,
            }),
          });
        };

        lifecycle.on("stateChange", onStateChange);

        // Heartbeat loop + keep connection alive
        while (!aborted) {
          await stream.sleep(30_000);
          if (aborted) break;
          await stream.writeSSE({
            event: "ping",
            data: "",
          });
        }

        lifecycle.off("stateChange", onStateChange);
      });
    });

    // Serve static files in production (if built)
    const webDist = findWebDist();
    if (webDist) {
      log.info(`Serving UI from: ${webDist}`);
      const indexHtml = readFileSync(join(webDist, "index.html"), "utf-8");

      const mimeTypes: Record<string, string> = {
        js: "application/javascript",
        css: "text/css",
        svg: "image/svg+xml",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        ico: "image/x-icon",
        json: "application/json",
        woff2: "font/woff2",
        woff: "font/woff",
      };

      // Serve static files (assets, images, etc.) with SPA fallback
      this.app.get("*", (c) => {
        const filePath = resolve(join(webDist, c.req.path));
        // Prevent path traversal — resolved path must stay inside webDist
        const rel = relative(webDist, filePath);
        if (rel.startsWith("..") || resolve(filePath) !== filePath) {
          return c.html(indexHtml);
        }

        // Try serving the actual file
        try {
          const content = readFileSync(filePath);
          const ext = filePath.split(".").pop() || "";
          if (mimeTypes[ext]) {
            // Vite hashes asset filenames (e.g. /assets/index-abc123.js) — safe to cache forever.
            // All other static files must not be cached so browsers always fetch the latest
            // version after a rebuild.
            const immutable = c.req.path.startsWith("/assets/");
            return c.body(content, 200, {
              "Content-Type": mimeTypes[ext],
              "Cache-Control": immutable
                ? "public, max-age=31536000, immutable"
                : "no-cache, no-store, must-revalidate",
            });
          }
        } catch {
          // File not found — fall through to SPA
        }

        // SPA fallback: serve index.html for all non-file routes (never cache)
        return c.html(indexHtml, 200, {
          "Cache-Control": "no-cache, no-store, must-revalidate",
        });
      });
    } else {
      log.warn(
        "Web UI build not found (dist/web/index.html missing) — run `npm run build:web` to build the frontend"
      );
    }

    // Error handler
    this.app.onError((err, c) => {
      log.error({ err }, "WebUI error");
      return c.json(
        {
          success: false,
          error: err.message || "Internal server error",
        },
        500
      );
    });
  }

  private setupNotificationTriggers() {
    const lifecycle = this.deps.lifecycle;
    if (!lifecycle) return;

    const svc = getNotificationService(this.deps.memory.db);

    lifecycle.on("stateChange", (event: StateChangeEvent) => {
      if (event.state === "stopped" && event.error) {
        svc.add("error", "Agent crashed", event.error);
        notificationBus.emit("update", svc.unreadCount());
      } else if (event.state === "stopped") {
        svc.add("info", "Agent stopped", "The agent has been stopped.");
        notificationBus.emit("update", svc.unreadCount());
      } else if (event.state === "running") {
        svc.add("info", "Agent started", "The agent is now running.");
        notificationBus.emit("update", svc.unreadCount());
      }
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Install log interceptor
        logInterceptor.install();

        // Start HTTP server
        this.server = serve(
          {
            fetch: this.app.fetch,
            hostname: this.deps.config.host,
            port: this.deps.config.port,
          },
          (info) => {
            const url = `http://${info.address}:${info.port}`;

            log.info(`WebUI server running`);
            log.info(`URL: ${url}/auth/exchange?token=${this.authToken}`);
            log.info(`Token: ${maskToken(this.authToken)} (use Bearer header for API access)`);
            resolve();
          }
        );
      } catch (error) {
        logInterceptor.uninstall();
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        (this.server as HttpServer).closeAllConnections();
        this.server?.close(() => {
          logInterceptor.uninstall();
          log.info("WebUI server stopped");
          resolve();
        });
      });
    }
  }

  getToken(): string {
    return this.authToken;
  }
}
