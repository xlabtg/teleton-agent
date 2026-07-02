import { describe, expect, it } from "vitest";
import { getModelsForProvider } from "../../config/model-catalog.js";
import { getProviderMetadata } from "../../config/providers.js";
import { AgentConfigSchema } from "../../config/schema.js";
import { getProviderModel } from "../model-resolver.js";

describe("Anthropic provider registration", () => {
  it("defaults to the current Opus model for primary calls", () => {
    const meta = getProviderMetadata("anthropic");

    expect(meta.defaultModel).toBe("claude-opus-4-8");
    expect(meta.utilityModel).toBe("claude-haiku-4-5-20251001");
  });

  it("resolves Claude Opus 4.8 even before pi-ai ships it in the generated registry", () => {
    const model = getProviderModel("anthropic", "claude-opus-4-8");

    expect(model.id).toBe("claude-opus-4-8");
    expect(model.api).toBe("anthropic-messages");
    expect(model.provider).toBe("anthropic");
    expect(model.contextWindow).toBe(1_000_000);
    expect(model.maxTokens).toBe(128_000);
  });

  it("exposes Claude Opus 4.8 first in the setup model catalog", () => {
    const models = getModelsForProvider("anthropic");

    expect(models[0]?.value).toBe("claude-opus-4-8");
  });

  it("uses Claude Opus 4.8 in AgentConfigSchema defaults", () => {
    const result = AgentConfigSchema.parse({});

    expect(result.model).toBe("claude-opus-4-8");
  });
});
