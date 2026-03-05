import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { testGroqApiKey } from "../groq/GroqTextProvider.js";

// Helper to mock global fetch
function mockFetch(status: number, body = "") {
  const mockResponse = {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(body),
    json: vi.fn().mockResolvedValue({ data: [] }),
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));
  return mockResponse;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("testGroqApiKey", () => {
  it("returns valid=true when API responds with 200", async () => {
    mockFetch(200);
    const result = await testGroqApiKey("gsk_valid_key");
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
    expect(result.statusCode).toBeNull();
    expect(result.hint).toBeNull();
  });

  it("returns valid=false with statusCode=401 on unauthorized", async () => {
    mockFetch(401, '{"error":"Invalid API Key"}');
    const result = await testGroqApiKey("gsk_bad_key");
    expect(result.valid).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.hint).toContain("Invalid API key");
  });

  it("returns valid=false with statusCode=403 on forbidden", async () => {
    mockFetch(403, '{"error":"Forbidden"}');
    const result = await testGroqApiKey("gsk_restricted_key");
    expect(result.valid).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.hint).toContain("plan");
  });

  it("returns valid=false with statusCode=429 on rate limit", async () => {
    mockFetch(429, '{"error":"Too Many Requests"}');
    const result = await testGroqApiKey("gsk_rate_limited_key");
    expect(result.valid).toBe(false);
    expect(result.statusCode).toBe(429);
    expect(result.hint).toContain("Rate limit");
  });

  it("returns valid=false with statusCode=500 on server error", async () => {
    mockFetch(500, '{"error":"Internal Server Error"}');
    const result = await testGroqApiKey("gsk_valid_key");
    expect(result.valid).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.hint).toContain("server error");
  });

  it("returns valid=false with hint for empty key", async () => {
    const result = await testGroqApiKey("");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("No API key");
    expect(result.hint).toBeDefined();
  });

  it("includes error message on failure", async () => {
    mockFetch(401, '{"error":"Invalid API Key"}');
    const result = await testGroqApiKey("gsk_bad");
    expect(result.error).toContain("401");
  });
});
