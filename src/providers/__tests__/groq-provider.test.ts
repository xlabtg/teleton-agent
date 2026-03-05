import { describe, it, expect } from "vitest";
import { getProviderMetadata, validateApiKeyFormat } from "../../config/providers.js";
import { AgentConfigSchema } from "../../config/schema.js";
import {
  getModelsForProvider,
  getGroqSttModels,
  getGroqTtsModels,
} from "../../config/model-catalog.js";
import { ConfigSchema } from "../../config/schema.js";

describe("Groq provider registration", () => {
  it("is registered in the provider registry", () => {
    const meta = getProviderMetadata("groq");
    expect(meta.id).toBe("groq");
    expect(meta.displayName).toBe("Groq");
    expect(meta.envVar).toBe("GROQ_API_KEY");
    expect(meta.keyPrefix).toBe("gsk_");
    expect(meta.piAiProvider).toBe("groq");
  });

  it("has valid default and utility models", () => {
    const meta = getProviderMetadata("groq");
    expect(meta.defaultModel).toBe("llama-3.3-70b-versatile");
    expect(meta.utilityModel).toBe("llama-3.1-8b-instant");
  });

  it("has a tool limit defined", () => {
    const meta = getProviderMetadata("groq");
    expect(meta.toolLimit).toBe(128);
  });

  it("validates gsk_ key prefix", () => {
    expect(validateApiKeyFormat("groq", "gsk_valid_key_123")).toBeUndefined();
    const err = validateApiKeyFormat("groq", "invalid_key");
    expect(err).toBeDefined();
    expect(err).toContain("gsk_");
  });

  it("is accepted by AgentConfigSchema", () => {
    const result = AgentConfigSchema.safeParse({ provider: "groq" });
    expect(result.success).toBe(true);
  });
});

describe("Groq model catalog", () => {
  it("has text models for Groq", () => {
    const models = getModelsForProvider("groq");
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.value === "llama-3.3-70b-versatile")).toBe(true);
  });

  it("has STT models", () => {
    const models = getGroqSttModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.value.includes("whisper"))).toBe(true);
  });

  it("has TTS models", () => {
    const models = getGroqTtsModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.value.includes("playai"))).toBe(true);
  });

  it("all model options have value, name, and description", () => {
    const textModels = getModelsForProvider("groq");
    const sttModels = getGroqSttModels();
    const ttsModels = getGroqTtsModels();

    for (const m of [...textModels, ...sttModels, ...ttsModels]) {
      expect(typeof m.value).toBe("string");
      expect(m.value.length).toBeGreaterThan(0);
      expect(typeof m.name).toBe("string");
      expect(m.name.length).toBeGreaterThan(0);
      expect(typeof m.description).toBe("string");
    }
  });
});

describe("Groq config schema", () => {
  it("accepts groq config block with defaults", () => {
    const result = ConfigSchema.safeParse({
      agent: {
        provider: "groq",
        api_key: "gsk_testkey",
        model: "llama-3.3-70b-versatile",
      },
      telegram: {
        api_id: 12345,
        api_hash: "abc123",
        phone: "+12345678900",
      },
      groq: {
        stt_model: "whisper-large-v3-turbo",
        tts_model: "playai-tts",
        tts_voice: "Fritz-PlayAI",
        tts_format: "mp3",
        rate_limit_mode: "auto",
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groq?.stt_model).toBe("whisper-large-v3-turbo");
      expect(result.data.groq?.tts_model).toBe("playai-tts");
      expect(result.data.groq?.tts_voice).toBe("Fritz-PlayAI");
      expect(result.data.groq?.tts_format).toBe("mp3");
      expect(result.data.groq?.rate_limit_mode).toBe("auto");
    }
  });

  it("groq config is optional", () => {
    const result = ConfigSchema.safeParse({
      agent: {
        provider: "anthropic",
        api_key: "sk-ant-test",
        model: "claude-opus-4-6",
      },
      telegram: {
        api_id: 12345,
        api_hash: "abc123",
        phone: "+12345678900",
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groq).toBeUndefined();
    }
  });

  it("rejects invalid tts_format", () => {
    const result = ConfigSchema.safeParse({
      agent: {
        provider: "groq",
        api_key: "gsk_testkey",
        model: "llama-3.3-70b-versatile",
      },
      telegram: {
        api_id: 12345,
        api_hash: "abc123",
        phone: "+12345678900",
      },
      groq: {
        tts_format: "invalid_format",
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects invalid rate_limit_mode", () => {
    const result = ConfigSchema.safeParse({
      agent: {
        provider: "groq",
        api_key: "gsk_testkey",
        model: "llama-3.3-70b-versatile",
      },
      telegram: {
        api_id: 12345,
        api_hash: "abc123",
        phone: "+12345678900",
      },
      groq: {
        rate_limit_mode: "invalid",
      },
    });

    expect(result.success).toBe(false);
  });
});
