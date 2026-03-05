/**
 * Groq Text Provider — Direct Native Integration
 *
 * Provides direct access to Groq's chat completions API without
 * going through the @mariozechner/pi-ai abstraction layer.
 *
 * Used for:
 * - Testing API keys
 * - Fetching dynamic model lists from the Groq API
 * - Future: streaming support
 */

import { createLogger } from "../../utils/logger.js";
import { withGroqRateLimit, parseGroqErrorType } from "./rateLimiter.js";
import { GROQ_API_BASE } from "./GroqSTTProvider.js";

const log = createLogger("GroqText");

export interface GroqMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GroqCompletionOptions {
  apiKey: string;
  model?: string;
  messages: GroqMessage[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface GroqCompletionResult {
  id: string;
  model: string;
  content: string;
  finishReason: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Call Groq chat completions endpoint directly (no pi-ai abstraction).
 */
export async function groqComplete(options: GroqCompletionOptions): Promise<GroqCompletionResult> {
  const { apiKey, model = "llama-3.3-70b-versatile", messages, maxTokens, temperature } = options;

  if (!apiKey) {
    throw new Error("Groq API key is required");
  }

  return withGroqRateLimit(async () => {
    const body: Record<string, unknown> = {
      model,
      messages,
    };

    if (maxTokens != null) body.max_tokens = maxTokens;
    if (temperature != null) body.temperature = temperature;

    const response = await fetch(`${GROQ_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorType = parseGroqErrorType(response.status);
      const errorBody = await response.text().catch(() => "");
      const msg = `Groq API error (${response.status} ${errorType}): ${errorBody}`;
      log.error(msg);
      throw new Error(msg);
    }

    const result = (await response.json()) as {
      id: string;
      model: string;
      choices: Array<{
        message: { content: string };
        finish_reason: string;
      }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const choice = result.choices[0];
    return {
      id: result.id,
      model: result.model,
      content: choice?.message?.content ?? "",
      finishReason: choice?.finish_reason ?? "stop",
      usage: {
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
        totalTokens: result.usage.total_tokens,
      },
    };
  });
}

export interface GroqModelListEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  active: boolean;
  context_window: number;
}

/**
 * List available models from the Groq API dynamically.
 */
export async function groqListModels(apiKey: string): Promise<GroqModelListEntry[]> {
  if (!apiKey) {
    throw new Error("Groq API key is required");
  }

  const response = await fetch(`${GROQ_API_BASE}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorType = parseGroqErrorType(response.status);
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Groq models list error (${response.status} ${errorType}): ${errorBody}`);
  }

  const result = (await response.json()) as { data: GroqModelListEntry[] };
  log.debug(`Fetched ${result.data.length} models from Groq API`);
  return result.data;
}

/**
 * Test a Groq API key by making a minimal chat completion request.
 * Returns an error message string on failure, or null on success.
 */
export async function testGroqApiKey(apiKey: string): Promise<string | null> {
  try {
    await groqComplete({
      apiKey,
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 5,
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
