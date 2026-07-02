import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type Config } from "../../config/schema.js";
import type { ChatResponse } from "../client.js";

const chatWithContextMock = vi.hoisted(() => vi.fn());

vi.mock("../../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock("../../services/prometheus.js", () => ({
  recordLlmRequest: vi.fn(),
}));

vi.mock("../client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client.js")>();
  return {
    ...actual,
    chatWithContext: chatWithContextMock,
  };
});

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
});

function makeConfig(overrides: Partial<Config["agent"]> = {}): Config {
  return ConfigSchema.parse({
    agent: {
      provider: "anthropic",
      api_key: "sk-test",
      model: "claude-opus-4-6",
      max_tokens: 128,
      temperature: 0,
      max_agentic_iterations: 1,
      compaction: { enabled: false },
      session_reset_policy: {
        daily_reset_enabled: false,
        idle_expiry_enabled: false,
      },
      ...overrides,
    },
    telegram: {
      api_id: 1,
      api_hash: "hash",
      phone: "+10000000000",
      session_name: "test",
      admin_ids: [1001],
      owner_id: 1001,
      owner_name: "Owner",
    },
    embedding: { provider: "none" },
    vector_memory: {},
    audit_trail: { enabled: false },
    temporal_context: { enabled: false },
    self_correction: { enabled: false },
    autonomous: {},
    deals: { enabled: false },
    webui: { enabled: false },
    logging: { level: "error", pretty: false },
    dev: {},
    marketplace: {},
    tool_rag: { enabled: false },
    cache: { enabled: false },
    capabilities: {},
    integrations: { enabled: false },
    event_bus: { enabled: false },
    webhooks: { enabled: false },
    network: { enabled: false },
    ton_proxy: { enabled: false },
    heartbeat: { enabled: false },
    predictions: { enabled: false },
    feedback: { enabled: false },
    adaptive_prompting: { enabled: false },
    anomaly_detection: { enabled: false },
    mtproto: { enabled: false, proxies: [] },
    mcp: { servers: {} },
  });
}

function assistantResponse(text: string): ChatResponse {
  return {
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "endTurn",
      usage: { input: 1, output: 1 },
      timestamp: Date.now(),
    },
    text,
    context: { messages: [] },
  };
}

function errorResponse(errorMessage: string): ChatResponse {
  return {
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage,
      usage: { input: 0, output: 0 },
      timestamp: Date.now(),
    },
    text: "",
    context: { messages: [] },
  };
}

function emptyZeroTokenResponse(): ChatResponse {
  return {
    message: {
      role: "assistant",
      content: [],
      stopReason: "stop",
      usage: { input: 0, output: 0 },
      timestamp: Date.now(),
    },
    text: "",
    context: { messages: [] },
  };
}

async function flushMicrotasks(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

async function createRuntime(config = makeConfig()) {
  vi.resetModules();
  chatWithContextMock.mockReset();

  const home = mkdtempSync(join(tmpdir(), "teleton-runtime-retry-"));
  const previousHome = process.env.TELETON_HOME;
  process.env.TELETON_HOME = home;

  const { getDatabase, closeDatabase } = await import("../../memory/database.js");
  getDatabase({
    path: join(home, "memory.db"),
    enableVectorSearch: false,
  });

  const { AgentRuntime } = await import("../runtime.js");
  const runtime = new AgentRuntime(config, "Test soul");

  cleanup = () => {
    closeDatabase();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) {
      delete process.env.TELETON_HOME;
    } else {
      process.env.TELETON_HOME = previousHome;
    }
  };

  return runtime;
}

describe("AgentRuntime retry backoff", () => {
  it("passes the caller abort signal to chatWithContext", async () => {
    const runtime = await createRuntime();
    const controller = new AbortController();
    chatWithContextMock.mockResolvedValueOnce(assistantResponse("ok"));

    await expect(
      runtime.processMessage({
        chatId: "1001",
        userMessage: "hello",
        userName: "Owner",
        signal: controller.signal,
      })
    ).resolves.toMatchObject({
      content: "ok",
      toolCalls: [],
    });

    expect(chatWithContextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it("does not count a rate-limit retry against max_agentic_iterations", async () => {
    vi.useFakeTimers();
    const runtime = await createRuntime();
    chatWithContextMock
      .mockResolvedValueOnce(errorResponse("429 Too Many Requests"))
      .mockResolvedValueOnce(assistantResponse("ok after retry"));

    const resultPromise = runtime.processMessage({
      chatId: "1001",
      userMessage: "hello",
      userName: "Owner",
      toolContext: {
        senderId: 1001,
        config: makeConfig(),
      },
    });

    await flushMicrotasks();
    expect(chatWithContextMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toMatchObject({
      content: "ok after retry",
      toolCalls: [],
    });
    expect(chatWithContextMock).toHaveBeenCalledTimes(2);
  });

  it("reports Anthropic 410 responses as an unavailable model with recovery guidance", async () => {
    const runtime = await createRuntime();
    chatWithContextMock.mockResolvedValueOnce(errorResponse("410 status code (no body)"));

    await expect(
      runtime.processMessage({
        chatId: "1001",
        userMessage: "hello",
        userName: "Owner",
        toolContext: {
          senderId: 1001,
          config: makeConfig(),
        },
      })
    ).rejects.toThrow(
      'Provider anthropic rejected model "claude-opus-4-6" with 410 status code (no body)'
    );
    expect(chatWithContextMock).toHaveBeenCalledTimes(1);
  });

  it("stops a pending rate-limit backoff when the signal is aborted", async () => {
    vi.useFakeTimers();
    const runtime = await createRuntime();
    const controller = new AbortController();
    chatWithContextMock
      .mockResolvedValueOnce(errorResponse("429 Too Many Requests"))
      .mockResolvedValueOnce(assistantResponse("should not run"));

    const resultPromise = runtime.processMessage({
      chatId: "1001",
      userMessage: "hello",
      userName: "Owner",
      signal: controller.signal,
      toolContext: {
        senderId: 1001,
        config: makeConfig(),
      },
    });

    await flushMicrotasks();
    expect(chatWithContextMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    controller.abort(new Error("cancelled"));

    await expect(resultPromise).resolves.toMatchObject({
      content: "",
      toolCalls: [],
    });
    expect(chatWithContextMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers NVIDIA GLM-5.1 empty zero-token streams with one recovery prompt", async () => {
    vi.useFakeTimers();
    const config = makeConfig({
      provider: "nvidia",
      api_key: "nvapi-test",
      model: "z-ai/glm-5.1",
      max_agentic_iterations: 1,
    });
    const runtime = await createRuntime(config);
    chatWithContextMock
      .mockResolvedValueOnce(emptyZeroTokenResponse())
      .mockResolvedValueOnce(emptyZeroTokenResponse())
      .mockResolvedValueOnce(emptyZeroTokenResponse())
      .mockResolvedValueOnce(emptyZeroTokenResponse())
      .mockResolvedValueOnce(assistantResponse("ok after empty recovery"));

    const resultPromise = runtime.processMessage({
      chatId: "1001",
      userMessage: "hello",
      userName: "Owner",
      toolContext: {
        senderId: 1001,
        config,
      },
    });

    await flushMicrotasks();
    expect(chatWithContextMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(chatWithContextMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4000);
    await flushMicrotasks();
    expect(chatWithContextMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(6000);
    await flushMicrotasks();
    expect(chatWithContextMock).toHaveBeenCalledTimes(5);

    await expect(resultPromise).resolves.toMatchObject({
      content: "ok after empty recovery",
      toolCalls: [],
    });
    const recoveryOptions = chatWithContextMock.mock.calls[4]?.[1];
    expect(recoveryOptions).toMatchObject({
      systemPrompt: expect.stringContaining("previous NVIDIA GLM-5.1 streaming response was empty"),
    });
  });
});
