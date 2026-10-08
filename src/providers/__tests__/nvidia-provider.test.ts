import { describe, it, expect } from "vitest";
import { getProviderMetadata, validateApiKeyFormat } from "../../config/providers.js";
import { AgentConfigSchema } from "../../config/schema.js";
import { getModelsForProvider } from "../../config/model-catalog.js";
import { getProviderModel as getAgentProviderModel } from "../../agent/client.js";
import { getUtilityModel as getSummarizationUtilityModel } from "../model-resolver.js";

describe("NVIDIA provider registration", () => {
  it("is registered in the provider registry", () => {
    const meta = getProviderMetadata("nvidia");
    expect(meta.id).toBe("nvidia");
    expect(meta.displayName).toBe("NVIDIA NIM");
    expect(meta.envVar).toBe("NVIDIA_API_KEY");
    expect(meta.keyPrefix).toBe("nvapi-");
    expect(meta.piAiProvider).toBe("nvidia");
  });

  it("defaults to a currently routed NVIDIA chat model for primary and utility calls", () => {
    const meta = getProviderMetadata("nvidia");

    expect(meta.defaultModel).toBe("z-ai/glm-5.1");
    expect(meta.utilityModel).toBe("z-ai/glm-5.1");
  });

  it("is accepted by AgentConfigSchema", () => {
    const result = AgentConfigSchema.safeParse({ provider: "nvidia" });
    expect(result.success).toBe(true);
  });

  it("validates nvapi- key prefix", () => {
    expect(validateApiKeyFormat("nvidia", "nvapi-valid-key-123")).toBeUndefined();
    const err = validateApiKeyFormat("nvidia", "invalid_key");
    expect(err).toBeDefined();
    expect(err).toContain("nvapi-");
  });
});

describe("NVIDIA model routing", () => {
  it("uses the /v1 NVIDIA base URL for OpenAI-compatible chat completions", () => {
    const model = getAgentProviderModel("nvidia", "meta/llama-3.1-8b-instruct");

    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("nvidia");
    expect("baseUrl" in model && model.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
  });

  it("uses max_tokens compatibility for NVIDIA's OpenAI-compatible endpoint", () => {
    const model = getAgentProviderModel("nvidia", "meta/llama-3.1-8b-instruct");

    expect("compat" in model && model.compat?.maxTokensField).toBe("max_tokens");
    expect("compat" in model && model.compat?.supportsStrictMode).toBe(false);
    expect("compat" in model && model.compat?.supportsLongCacheRetention).toBe(false);
  });

  it("keeps GLM-5.1 on the OpenAI-compatible NVIDIA endpoint", () => {
    const model = getAgentProviderModel("nvidia", "z-ai/glm-5.1");

    expect(model.api).toBe("openai-completions");
    expect("compat" in model && model.compat?.supportsUsageInStreaming).toBe(false);
  });

  it("routes the summarization utility model through the NVIDIA OpenAI-compatible endpoint", () => {
    const model = getSummarizationUtilityModel("nvidia");

    expect(model.id).toBe("z-ai/glm-5.1");
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("nvidia");
    expect("baseUrl" in model && model.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
  });
});

describe("NVIDIA curated model catalog", () => {
  it("contains chat completion models", () => {
    const models = getModelsForProvider("nvidia");
    const values = models.map((m) => m.value);

    expect(models.length).toBeGreaterThan(0);
    expect(values).toContain("z-ai/glm-5.1");
    expect(values).toContain("z-ai/glm-5.3");
    expect(values).toContain("deepseek-ai/deepseek-v4.1-flash");
    expect(values).toContain("moonshotai/kimi-k3");
  });

  it("includes the provider default and utility models", () => {
    const values = getModelsForProvider("nvidia").map((m) => m.value);
    const meta = getProviderMetadata("nvidia");

    expect(values).toContain(meta.defaultModel);
    expect(values).toContain(meta.utilityModel);
  });

  it("does not expose embedding or reranking models in the chat provider dropdown", () => {
    const models = getModelsForProvider("nvidia");

    expect(models.some((m) => m.value === "baai/bge-m3")).toBe(false);
    expect(models.some((m) => m.value === "nvidia/embed-qa-4")).toBe(false);
    expect(models.some((m) => m.value === "nvidia/rerank-qa-mistral-4b")).toBe(false);
  });

  it("filters out stale preview models that were returning 404/410 errors", () => {
    const models = getModelsForProvider("nvidia");
    const values = models.map((m) => m.value);

    expect(values).not.toContain("qwen/qwen-2.5-72b-instruct");
    expect(values).not.toContain("mistralai/mistral-large-2411");
    expect(values).not.toContain("google/gemma-2-27b-it");
    expect(values).not.toContain("nvidia/llama-3.3-nemotron-super-49b-v1");
  });
});
