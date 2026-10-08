import { describe, expect, it } from "vitest";
import {
  getEmptyResponseDiagnostic,
  getEmptyResponseRecoveryPrompt,
} from "../../agent/runtime-utils.js";
import { getProviderModel } from "../model-resolver.js";
describe("NVIDIA GLM streaming compatibility (#753)", () => {
  it.each(["z-ai/glm-5", "z-ai/glm-5.1", "z-ai/glm-5-3", "z-ai/glm-5-future"])(
    "disables streaming usage for %s",
    (id) => {
      expect(getProviderModel("nvidia", id).compat?.supportsUsageInStreaming).toBe(false);
    }
  );
  it("leaves unrelated models unchanged", () => {
    expect(
      getProviderModel("nvidia", "meta/llama-3.1-70b-instruct").compat?.supportsUsageInStreaming
    ).toBeUndefined();
  });
});

import { getModelsForProvider } from "../../config/model-catalog.js";
import { getSupportedProviders } from "../../config/providers.js";
it.each(getSupportedProviders())("lists default and utility models for $id (#753)", (meta) => {
  const ids = getModelsForProvider(meta.id).map((model) => model.value);
  expect(ids).toContain(meta.defaultModel);
  expect(ids).toContain(meta.utilityModel);
});
it("applies GLM workarounds to every catalog entry (#753)", () => {
  for (const model of getModelsForProvider("nvidia").filter((model) =>
    model.value.startsWith("z-ai/glm-5")
  )) {
    expect(getProviderModel("nvidia", model.value).compat?.supportsUsageInStreaming).toBe(false);
    const empty = {
      provider: "nvidia",
      model: model.value,
      hasText: false,
      inputTokens: 0,
      outputTokens: 0,
    };
    expect(getEmptyResponseDiagnostic(empty)).not.toBeNull();
    expect(getEmptyResponseRecoveryPrompt(empty)).not.toBeNull();
  }
});
