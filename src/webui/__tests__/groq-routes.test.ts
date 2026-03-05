import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";

vi.mock("../../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock("../../config/configurable-keys.js", () => ({
  getNestedValue: vi.fn(),
  readRawConfig: vi.fn(),
}));

import { createGroqRoutes } from "../routes/groq.js";
import { getNestedValue, readRawConfig } from "../../config/configurable-keys.js";
import type { WebUIServerDeps } from "../types.js";

const mockDeps = {
  configPath: "/fake/config.yaml",
} as unknown as WebUIServerDeps;

function setupWithApiKey(apiKey: string) {
  vi.mocked(readRawConfig).mockReturnValue({});
  vi.mocked(getNestedValue).mockReturnValue(apiKey);
}

function setupNoApiKey() {
  vi.mocked(readRawConfig).mockImplementation(() => {
    throw new Error("no config");
  });
}

// Mock fetch for API key tests
function mockFetch(status: number, body = "") {
  const mockResponse = {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(body),
    json: vi.fn().mockResolvedValue({ data: [] }),
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function buildApp() {
  const app = new Hono();
  app.route("/groq", createGroqRoutes(mockDeps));
  return app;
}

describe("GET /groq/debug", () => {
  it("returns debug info with baseURL and auth header shape", async () => {
    setupWithApiKey("gsk_testkey123");
    const app = buildApp();
    const res = await app.request("/groq/debug");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.baseURL).toBe("https://api.groq.com/openai/v1");
    expect(json.data.apiKeyConfigured).toBe(true);
    expect(json.data.authHeaderShape).toContain("Bearer");
    // Should not expose the actual key value
    expect(JSON.stringify(json)).not.toContain("gsk_testkey123");
  });

  it("reports apiKeyConfigured=false when no key is set", async () => {
    setupNoApiKey();
    const app = buildApp();
    const res = await app.request("/groq/debug");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.apiKeyConfigured).toBe(false);
    expect(json.data.authHeaderShape).toContain("not set");
  });
});

describe("POST /groq/test", () => {
  it("returns 200 when API key is valid", async () => {
    setupWithApiKey("gsk_validkey");
    mockFetch(200);
    const app = buildApp();
    const res = await app.request("/groq/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.valid).toBe(true);
  });

  it("returns 400 when no API key is configured", async () => {
    setupNoApiKey();
    const app = buildApp();
    const res = await app.request("/groq/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it("returns 401 when Groq API returns 401", async () => {
    setupWithApiKey("gsk_bad");
    mockFetch(401, '{"error":"Invalid API Key"}');
    const app = buildApp();
    const res = await app.request("/groq/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.hint).toContain("Invalid API key");
  });

  it("returns 403 when Groq API returns 403", async () => {
    setupWithApiKey("gsk_restricted");
    mockFetch(403, '{"error":"Forbidden"}');
    const app = buildApp();
    const res = await app.request("/groq/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it("returns 429 when Groq API returns 429", async () => {
    setupWithApiKey("gsk_limited");
    mockFetch(429, '{"error":"Too Many Requests"}');
    const app = buildApp();
    const res = await app.request("/groq/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it("returns 502 when Groq API returns 500", async () => {
    setupWithApiKey("gsk_valid");
    mockFetch(500, '{"error":"Server Error"}');
    const app = buildApp();
    const res = await app.request("/groq/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it("accepts apiKey in body and uses it over configured key", async () => {
    setupWithApiKey("gsk_configured");
    mockFetch(200);
    const app = buildApp();
    const res = await app.request("/groq/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "gsk_from_body" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  it("returns 400 for invalid JSON body", async () => {
    setupWithApiKey("gsk_valid");
    const app = buildApp();
    const res = await app.request("/groq/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });
});
