import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../../config/schema.js";

const mockComplete = vi.fn();

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    complete: (...args: unknown[]) => mockComplete(...args),
  };
});

function agentConfig(): AgentConfig {
  return {
    provider: "nvidia",
    api_key: "nvapi-test-key",
    model: "meta/llama-3.1-8b-instruct",
    max_tokens: 1024,
    temperature: 0.7,
    system_prompt: null,
    max_agentic_iterations: 5,
    session_reset_policy: {
      daily_reset_enabled: false,
      daily_reset_hour: 4,
      idle_expiry_enabled: false,
      idle_expiry_minutes: 1440,
    },
    compaction: {
      enabled: false,
      log_compaction: true,
      auto_preserve: true,
    },
  };
}

function makeAssistantMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "nvidia",
    model: "meta/llama-3.1-8b-instruct",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

type CapturedCompleteOptions = {
  signal?: AbortSignal;
};

function getCapturedCompleteOptions(): CapturedCompleteOptions {
  const [, , options] = mockComplete.mock.calls[0] as [unknown, unknown, CapturedCompleteOptions];
  return options;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockComplete.mockResolvedValue(makeAssistantMessage("ok"));
});

describe("chatWithContext abort signal handling", () => {
  it("aborts the in-flight LLM request signal when the caller signal fires", async () => {
    const { chatWithContext } = await import("../client.js");
    const controller = new AbortController();

    await chatWithContext(agentConfig(), {
      context: { messages: [], systemPrompt: "test" },
      signal: controller.signal,
    });

    const completeSignal = getCapturedCompleteOptions().signal;
    expect(completeSignal).toBeInstanceOf(AbortSignal);
    expect(completeSignal?.aborted).toBe(false);

    const reason = new Error("caller cancelled");
    controller.abort(reason);

    expect(completeSignal?.aborted).toBe(true);
    expect(completeSignal?.reason).toBe(reason);
  });

  it("omits temperature for Claude Opus 4.8 requests", async () => {
    const { chatWithContext } = await import("../client.js");

    await chatWithContext(
      {
        ...agentConfig(),
        provider: "anthropic",
        api_key: "sk-ant-test-key",
        model: "claude-opus-4-8",
        temperature: 0.7,
      },
      {
        context: { messages: [], systemPrompt: "test" },
      }
    );

    expect(getCapturedCompleteOptions()).not.toHaveProperty("temperature");
  });
});
