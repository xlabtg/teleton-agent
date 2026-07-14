import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationEntity } from "../base.js";
import { HttpIntegrationProvider } from "../providers.js";

const dnsMocks = vi.hoisted(() => ({
  lookup: vi.fn(),
}));

vi.mock("node:dns/promises", () => dnsMocks);

const auth = {
  resolveHeaders: vi.fn().mockResolvedValue({}),
};

function makeEntity(overrides: Partial<IntegrationEntity> = {}): IntegrationEntity {
  return {
    id: "custom-api",
    name: "Custom API",
    type: "api",
    provider: "custom-http",
    auth: { type: "none" },
    authId: null,
    config: {},
    status: "unknown",
    healthCheckUrl: null,
    lastHealthAt: null,
    lastHealthMessage: null,
    createdAt: 0,
    updatedAt: 0,
    stats: {
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      lastExecutedAt: null,
      avgLatencyMs: null,
    },
    ...overrides,
  };
}

describe("HttpIntegrationProvider outbound URL security", () => {
  beforeEach(() => {
    dnsMocks.lookup.mockReset();
    dnsMocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    auth.resolveHeaders.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects action requests targeting the cloud metadata IP", async () => {
    const fetchMock = vi.fn();
    const provider = new HttpIntegrationProvider(makeEntity(), {
      auth: auth as never,
      fetchImpl: fetchMock as typeof fetch,
    });

    const result = await provider.execute("request", {
      url: "http://169.254.169.254/latest/meta-data/",
    });

    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/private|loopback|metadata|not allowed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects action hostnames that resolve to private addresses", async () => {
    dnsMocks.lookup.mockResolvedValueOnce([{ address: "10.0.0.8", family: 4 }]);
    const fetchMock = vi.fn();
    const provider = new HttpIntegrationProvider(makeEntity(), {
      auth: auth as never,
      fetchImpl: fetchMock as typeof fetch,
    });

    const result = await provider.execute("request", {
      url: "https://rebind.example.com/private",
    });

    expect(dnsMocks.lookup).toHaveBeenCalledWith("rebind.example.com", {
      all: true,
      verbatim: true,
    });
    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/private|loopback|metadata|not allowed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the request timeout when outbound URL validation fails", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const provider = new HttpIntegrationProvider(makeEntity(), {
      auth: auth as never,
      fetchImpl: vi.fn() as typeof fetch,
    });

    await provider.execute("request", {
      url: "http://169.254.169.254/latest/meta-data/",
    });

    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("subjects health checks to the same outbound URL guard", async () => {
    const fetchMock = vi.fn();
    const provider = new HttpIntegrationProvider(
      makeEntity({ healthCheckUrl: "http://127.0.0.1:8080/health" }),
      { auth: auth as never, fetchImpl: fetchMock as typeof fetch }
    );

    const health = await provider.healthCheck();

    expect(health.status).toBe("unhealthy");
    expect(health.message).toMatch(/private|loopback|metadata|not allowed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches public action URLs through a DNS-pinned dispatcher", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const provider = new HttpIntegrationProvider(makeEntity(), {
      auth: auth as never,
      fetchImpl: fetchMock as typeof fetch,
    });

    const result = await provider.execute("request", {
      url: "https://api.example.com/resource",
    });

    expect(result).toMatchObject({ success: true, status: 200, data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit & { dispatcher?: unknown }];
    expect(String(url)).toBe("https://api.example.com/resource");
    expect(init.dispatcher).toBeDefined();
    expect(init.redirect).toBe("manual");
  });
});
