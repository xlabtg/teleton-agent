import {
  complete,
  stream,
  type Context,
  type AssistantMessage,
  type Message,
  type Tool,
  type ProviderStreamOptions,
} from "@mariozechner/pi-ai";
import type { AgentConfig } from "../config/schema.js";
import { appendToTranscript, readTranscript } from "../session/transcript.js";
import { type SupportedProvider } from "../config/providers.js";
import { sanitizeToolsForGemini } from "./schema-sanitizer.js";
import { createLogger } from "../utils/logger.js";
import {
  getClaudeCodeApiKey,
  refreshClaudeCodeApiKey,
} from "../providers/claude-code-credentials.js";
import { LLM_REQUEST_TIMEOUT_MS } from "../constants/timeouts.js";

// Model resolution + provider model registration live in the neutral providers/
// layer so non-agent consumers (e.g. memory) can resolve models without importing
// from agent/. Re-exported here for backward compatibility with existing importers.
import { getProviderModel } from "../providers/model-resolver.js";
export {
  registerGocoonModels,
  registerLocalModels,
  getProviderModel,
  getUtilityModel,
} from "../providers/model-resolver.js";

const log = createLogger("LLM");

export function isOAuthToken(apiKey: string, provider?: string): boolean {
  if (provider && provider !== "anthropic" && provider !== "claude-code") return false;
  return apiKey.startsWith("sk-ant-oat01-");
}

/** Resolve the effective API key for a provider (local/gocoon need no real key) */
export function getEffectiveApiKey(provider: string, rawKey: string): string {
  if (provider === "local") return "local";
  if (provider === "gocoon") return "gocoon";
  if (provider === "claude-code") return getClaudeCodeApiKey(rawKey);
  return rawKey;
}

// NVIDIA NIM rejects long cache retention and clamps temperature to [0, 1]; the
// rest of the providers keep pi-ai's defaults.
const NVIDIA_CACHE_RETENTION = "none";
const DEFAULT_CACHE_RETENTION = "long";
const NVIDIA_MAX_TEMPERATURE = 1;

function normalizeProviderTemperature(provider: SupportedProvider, temperature: number): number {
  if (provider !== "nvidia" || !Number.isFinite(temperature)) {
    return temperature;
  }

  return Math.min(Math.max(temperature, 0), NVIDIA_MAX_TEMPERATURE);
}

function shouldOmitProviderTemperature(provider: SupportedProvider, modelId: string): boolean {
  if (provider !== "anthropic" && provider !== "claude-code") return false;

  return /^claude-opus-4-(?:7|8)(?:$|-)/.test(modelId.toLowerCase());
}

export interface ChatOptions {
  systemPrompt?: string;
  context: Context;
  sessionId?: string;
  maxTokens?: number;
  temperature?: number;
  persistTranscript?: boolean;
  tools?: Tool[];
  signal?: AbortSignal;
}

export interface ChatResponse {
  message: AssistantMessage;
  text: string;
  context: Context;
}

const THINK_RE = /<think>[\s\S]*?<\/think>/g;

/**
 * Shared post-processing for both complete() and stream() responses: strip
 * <think> blocks (Mistral, local models, etc.), persist the transcript, extract the
 * text content, and append the response to the context.
 */
function finalizeResponse(
  response: AssistantMessage,
  context: Context,
  options: ChatOptions
): ChatResponse {
  for (const block of response.content) {
    if (block.type === "text" && block.text.includes("<think>")) {
      block.text = block.text.replace(THINK_RE, "").trim();
    }
  }

  if (options.persistTranscript && options.sessionId) {
    appendToTranscript(options.sessionId, response);
  }

  const textContent = response.content.find((block) => block.type === "text");
  const text = textContent?.type === "text" ? textContent.text : "";

  const updatedContext: Context = {
    ...context,
    messages: [...context.messages, response],
  };

  return { message: response, text, context: updatedContext };
}

export async function chatWithContext(
  config: AgentConfig,
  options: ChatOptions
): Promise<ChatResponse> {
  const provider = (config.provider || "anthropic") as SupportedProvider;
  const model = getProviderModel(provider, config.model);
  const tools =
    provider === "google" && options.tools ? sanitizeToolsForGemini(options.tools) : options.tools;

  const systemPrompt = options.systemPrompt || options.context.systemPrompt || "";

  const context: Context = {
    ...options.context,
    systemPrompt,
    tools,
  };

  const temperature = normalizeProviderTemperature(
    provider,
    options.temperature ?? config.temperature
  );

  const requestTimeoutSignal = AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS);
  const completeOptions: Record<string, unknown> = {
    apiKey: getEffectiveApiKey(provider, config.api_key),
    maxTokens: options.maxTokens ?? config.max_tokens,
    sessionId: options.sessionId,
    cacheRetention: provider === "nvidia" ? NVIDIA_CACHE_RETENTION : DEFAULT_CACHE_RETENTION,
    signal: options.signal
      ? AbortSignal.any([options.signal, requestTimeoutSignal])
      : requestTimeoutSignal,
  };
  if (!shouldOmitProviderTemperature(provider, config.model)) {
    completeOptions.temperature = temperature;
  }

  let response = await complete(model, context, completeOptions as ProviderStreamOptions);

  // Claude Code provider: retry once on 401/Unauthorized by refreshing credentials.
  // Use precise patterns to avoid false positives from upstream bodies that happen to contain "401".
  if (
    provider === "claude-code" &&
    response.stopReason === "error" &&
    response.errorMessage &&
    (/\b401\b/.test(response.errorMessage) || /\bunauthorized\b/i.test(response.errorMessage))
  ) {
    log.warn("Claude Code token rejected (401), refreshing credentials and retrying...");
    const refreshedKey = await refreshClaudeCodeApiKey();
    if (refreshedKey) {
      completeOptions.apiKey = refreshedKey;
      response = await complete(model, context, completeOptions as ProviderStreamOptions);
    }
  }

  return finalizeResponse(response, context, options);
}

export interface StreamResult {
  textStream: AsyncIterable<string>;
  result: Promise<ChatResponse>;
}

export function streamWithContext(config: AgentConfig, options: ChatOptions): StreamResult {
  const provider = (config.provider || "anthropic") as SupportedProvider;
  const model = getProviderModel(provider, config.model);

  const tools =
    provider === "google" && options.tools ? sanitizeToolsForGemini(options.tools) : options.tools;

  const systemPrompt = options.systemPrompt || options.context.systemPrompt || "";

  const context: Context = {
    ...options.context,
    systemPrompt,
    tools,
  };

  const temperature = normalizeProviderTemperature(
    provider,
    options.temperature ?? config.temperature
  );

  const streamOptions: Record<string, unknown> = {
    apiKey: getEffectiveApiKey(provider, config.api_key),
    maxTokens: options.maxTokens ?? config.max_tokens,
    sessionId: options.sessionId,
    cacheRetention: provider === "nvidia" ? NVIDIA_CACHE_RETENTION : DEFAULT_CACHE_RETENTION,
  };
  if (!shouldOmitProviderTemperature(provider, config.model)) {
    streamOptions.temperature = temperature;
  }

  const eventStream = stream(model, context, streamOptions as ProviderStreamOptions);

  // Transform event stream into a simple text delta async iterable
  async function* textDeltas(): AsyncIterable<string> {
    for await (const event of eventStream) {
      if (event.type === "text_delta" && event.delta) {
        yield event.delta;
      }
      // Stop yielding text when tool calls start — the response needs full processing
      if (event.type === "toolcall_start") {
        return;
      }
    }
  }

  // Result promise: wait for the stream to complete and build ChatResponse
  const resultPromise = (async (): Promise<ChatResponse> => {
    const response = await eventStream.result();
    return finalizeResponse(response, context, options);
  })();

  return { textStream: textDeltas(), result: resultPromise };
}

export function loadContextFromTranscript(sessionId: string, systemPrompt?: string): Context {
  const messages = readTranscript(sessionId) as Message[];

  // Deduplicate toolResult messages by toolCallId (prevents API 400 on corrupted transcripts)
  const seenToolCallIds = new Set<string>();
  const deduped = messages.filter((msg) => {
    if (msg.role !== "toolResult") return true;
    const id = (msg as { toolCallId: string }).toolCallId;
    if (seenToolCallIds.has(id)) return false;
    seenToolCallIds.add(id);
    return true;
  });

  return {
    systemPrompt,
    messages: deduped,
  };
}

export function createClient(_config: AgentConfig): null {
  return null;
}
