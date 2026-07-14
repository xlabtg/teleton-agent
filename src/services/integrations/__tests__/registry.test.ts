import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  IntegrationAuthManager,
  IntegrationRateLimitError,
  IntegrationRateLimiter,
  IntegrationRegistry,
} from "../index.js";

const dnsMocks = vi.hoisted(() => ({
  lookup: vi.fn(),
}));

vi.mock("node:dns/promises", () => dnsMocks);

vi.mock("../../../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe("IntegrationRegistry", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    dnsMocks.lookup.mockReset();
    dnsMocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    db.close();
  });

  it("exposes built-in integration templates from the catalog", () => {
    const registry = new IntegrationRegistry({ db });

    const ids = registry.getCatalog().map((entry) => entry.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        "telegram",
        "slack",
        "github",
        "jira",
        "notion",
        "google-workspace",
        "smtp-email",
        "custom-http",
        "mcp",
      ])
    );
  });

  it("creates, updates, lists, and deletes configured integrations", () => {
    const registry = new IntegrationRegistry({ db });

    const created = registry.create({
      id: "support-api",
      name: "Support API",
      type: "api",
      provider: "custom-http",
      config: { baseUrl: "https://example.com", actions: {} },
      healthCheckUrl: "https://example.com/health",
    });

    expect(created.id).toBe("support-api");
    expect(created.status).toBe("unconfigured");
    expect(registry.list()).toHaveLength(1);

    const updated = registry.update("support-api", {
      name: "Support API v2",
      config: { baseUrl: "https://api.example.com" },
    });

    expect(updated?.name).toBe("Support API v2");
    expect(updated?.config).toMatchObject({ baseUrl: "https://api.example.com" });
    expect(registry.delete("support-api")).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  it("stores credentials encrypted and returns masked credential metadata", () => {
    const registry = new IntegrationRegistry({ db, credentialKey: "test-master-key" });
    registry.create({
      id: "github-main",
      name: "GitHub Main",
      type: "api",
      provider: "github",
      config: { baseUrl: "https://api.github.com" },
    });
    const auth = new IntegrationAuthManager(db, "test-master-key");

    const credential = auth.createCredential({
      integrationId: "github-main",
      authType: "api_key",
      credentials: { apiKey: "ghp_secret_token", headerName: "Authorization", prefix: "Bearer" },
      expiresAt: null,
    });

    const raw = db
      .prepare("SELECT credentials_encrypted FROM integration_credentials WHERE id = ?")
      .get(credential.id) as { credentials_encrypted: string };

    expect(raw.credentials_encrypted).not.toContain("ghp_secret_token");
    expect(auth.getCredential(credential.id)?.credentials).toMatchObject({
      apiKey: "ghp_secret_token",
    });
    expect(auth.listCredentials("github-main")[0].credentials).toEqual({
      apiKey: "gh...en",
      headerName: "Authorization",
      prefix: "Bearer",
    });
  });

  it("builds OAuth authorization URLs for OAuth-backed integrations", () => {
    const auth = new IntegrationAuthManager(db, "test-master-key");

    const url = new URL(
      auth.buildOAuthAuthorizationUrl({
        authorizeUrl: "https://accounts.example.com/oauth/authorize",
        clientId: "client-123",
        redirectUri: "https://teleton.example.com/callback",
        scopes: ["read", "write"],
        state: "state-token",
        extraParams: { access_type: "offline" },
      })
    );

    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://teleton.example.com/callback");
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("state")).toBe("state-token");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("applies per-integration and global rate limits", async () => {
    const limiter = new IntegrationRateLimiter({
      global: { requestsPerMinute: 2 },
      now: () => 1_000,
    });

    await limiter.schedule("github-main", { requestsPerMinute: 1 }, async () => "ok");

    await expect(
      limiter.schedule("github-main", { requestsPerMinute: 1 }, async () => "blocked")
    ).rejects.toBeInstanceOf(IntegrationRateLimitError);

    await limiter.schedule("notion-main", {}, async () => "ok");

    await expect(limiter.schedule("slack-main", {}, async () => "blocked")).rejects.toMatchObject({
      scope: "global",
    });
  });

  it("executes a configured HTTP action with stored authentication", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/echo") {
        const headers = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            method: init?.method,
            authorization: headers.get("authorization"),
            body: init?.body ? JSON.parse(String(init.body)) : null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    const registry = new IntegrationRegistry({
      db,
      credentialKey: "test-master-key",
      fetchImpl: fetchMock as typeof fetch,
    });
    const integration = registry.create({
      id: "echo-api",
      name: "Echo API",
      type: "api",
      provider: "custom-http",
      config: {
        baseUrl: "https://api.example.com",
        actions: {
          echo: { method: "POST", path: "/echo" },
        },
        rateLimit: { requestsPerMinute: 10 },
      },
      auth: { type: "api_key" },
      healthCheckUrl: "https://api.example.com/health",
    });

    const credential = registry.auth.createCredential({
      integrationId: integration.id,
      authType: "api_key",
      credentials: { apiKey: "secret-token", headerName: "Authorization", prefix: "Bearer" },
      expiresAt: null,
    });
    registry.update(integration.id, { authId: credential.id });

    const health = await registry.healthCheck(integration.id);
    expect(health.status).toBe("healthy");

    const result = await registry.execute(integration.id, "echo", {
      body: { message: "hello" },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      method: "POST",
      authorization: "Bearer secret-token",
      body: { message: "hello" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
