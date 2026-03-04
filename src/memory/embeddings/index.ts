import type { EmbeddingProvider, EmbeddingProviderConfig } from "./provider.js";
import { NoopEmbeddingProvider } from "./provider.js";
import { AnthropicEmbeddingProvider } from "./anthropic.js";
import { LocalEmbeddingProvider } from "./local.js";

export * from "./provider.js";
export * from "./anthropic.js";
export * from "./local.js";
export * from "./cached.js";
export * from "./utils.js";

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  switch (config.provider) {
    case "anthropic":
      if (!config.apiKey) {
        throw new Error("API key required for Anthropic embedding provider");
      }
      return new AnthropicEmbeddingProvider({
        apiKey: config.apiKey,
        model: config.model,
      });

    case "local":
      return new LocalEmbeddingProvider({
        model: config.model,
      });

    case "none":
      return new NoopEmbeddingProvider();

    default:
      throw new Error(`Unknown embedding provider: ${config.provider}`);
  }
}
