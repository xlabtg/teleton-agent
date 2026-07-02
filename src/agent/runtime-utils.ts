import type { Context, TextContent, ToolCall } from "@mariozechner/pi-ai";

export function isContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("prompt is too long") ||
    lower.includes("context length exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("too many tokens") ||
    lower.includes("request_too_large") ||
    (lower.includes("exceeds") && lower.includes("maximum")) ||
    (lower.includes("context") && lower.includes("limit"))
  );
}

/**
 * Extracts the Retry-After value (in milliseconds) from an error message if the
 * API includes one (e.g. "retry-after: 30" or "Retry-After: 60").
 * Returns null if no Retry-After hint is present.
 */
export function parseRetryAfterMs(errorMessage: string): number | null {
  const match = errorMessage.match(/retry.after[:\s]+(\d+)/i);
  return match ? Number(match[1]) * 1000 : null;
}

function getAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(signal.reason ? String(signal.reason) : "Operation aborted");
}

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(getAbortError(signal));
  }
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();

    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        cleanup();
        reject(getAbortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Returns true for errors thrown by the provider library that indicate a
 * transient network-level failure (e.g. "Unhandled stop reason: network_error").
 * Also handles AbortError/TimeoutError thrown when the LLM request timeout fires.
 */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // AbortSignal.timeout() throws a DOMException with name "TimeoutError"
  if ("name" in error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return true;
  }
  return isNetworkErrorMessage(error.message);
}

/**
 * Returns true if an error message string indicates a transient network-level
 * failure. Used for both thrown exceptions (isNetworkError) and stopReason:"error"
 * responses where errorMessage contains network error details (e.g. from the zai
 * provider returning "Provider finish_reason: network_error", "Connection error.",
 * or "Request timed out.").
 */
export function isNetworkErrorMessage(message: string): boolean {
  const msg = message.toLowerCase();
  return (
    msg.includes("network_error") ||
    msg.includes("network error") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed") ||
    msg.includes("unhandled stop reason") ||
    msg.includes("connection error") ||
    msg.includes("request timed out")
  );
}

export interface ModelUnavailableDiagnosticInput {
  provider: string;
  model: string;
  errorMessage: string;
  defaultModel?: string;
}

export function isModelUnavailableError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return (
    /\b410\b/.test(lower) ||
    lower.includes("gone") ||
    lower.includes("model not found") ||
    lower.includes("model_not_found") ||
    lower.includes("model unavailable") ||
    lower.includes("model_unavailable") ||
    lower.includes("not available or recognized") ||
    lower.includes("does not exist") ||
    (lower.includes("selected model") && lower.includes("not available"))
  );
}

export function getModelUnavailableDiagnostic(
  input: ModelUnavailableDiagnosticInput
): string | null {
  if (!isModelUnavailableError(input.errorMessage)) return null;

  const base =
    `Provider ${input.provider} rejected model "${input.model}" with ${input.errorMessage}. ` +
    "This usually means the configured model ID or provider endpoint is no longer available.";

  if (input.defaultModel && input.defaultModel !== input.model) {
    return `${base} Update agent.model to "${input.defaultModel}" or run teleton setup again.`;
  }

  return `${base} Choose a currently supported model for this provider and update agent.model.`;
}

export interface EmptyResponseDiagnosticInput {
  provider: string;
  model: string;
  hasText: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

function isEmptyResponseWithoutUsage(input: EmptyResponseDiagnosticInput): boolean {
  const hasTokens = (input.inputTokens ?? 0) > 0 || (input.outputTokens ?? 0) > 0;
  return !input.hasText && !hasTokens;
}

export function isNvidiaGlm51EmptyResponse(input: EmptyResponseDiagnosticInput): boolean {
  return (
    isEmptyResponseWithoutUsage(input) &&
    input.provider.toLowerCase() === "nvidia" &&
    input.model.toLowerCase() === "z-ai/glm-5.1"
  );
}

export function getEmptyResponseRecoveryPrompt(input: EmptyResponseDiagnosticInput): string | null {
  if (!isNvidiaGlm51EmptyResponse(input)) return null;

  return (
    "Provider recovery: the previous NVIDIA GLM-5.1 streaming response was empty " +
    "and reported zero token usage. Continue the same user request with the native tools " +
    "already available in this request. Return either the next tool call(s) needed to make " +
    "progress or a concise final answer; do not return an empty message."
  );
}

export function getEmptyResponseDiagnostic(input: EmptyResponseDiagnosticInput): string | null {
  if (!isEmptyResponseWithoutUsage(input)) return null;

  if (isNvidiaGlm51EmptyResponse(input)) {
    return (
      "NVIDIA NIM z-ai/glm-5.1 returned an empty streaming response with zero token usage. " +
      "Teleton sends this model through NVIDIA's OpenAI-compatible Chat Completions endpoint " +
      "with native tools enabled. If the same model works in the NVIDIA web UI but not through " +
      "the API, verify that the nvapi key's organization has Public API Endpoints access and " +
      "that z-ai/glm-5.1 is available for that key."
    );
  }

  return null;
}

export function isTrivialMessage(text: string): boolean {
  const stripped = text.trim();
  if (!stripped) return true;
  if (!/[a-zA-Z0-9а-яА-ЯёЁ]/.test(stripped)) return true;
  const trivial =
    /^(ok|okay|k|oui|non|yes|no|yep|nope|sure|thanks|merci|thx|ty|lol|haha|cool|nice|wow|bravo|top|parfait|d'accord|alright|fine|got it|np|gg)\.?!?$/i;
  return trivial.test(stripped);
}

export function extractContextSummary(context: Context, maxMessages: number = 10): string {
  const recentMessages = context.messages.slice(-maxMessages);
  const summaryParts: string[] = [];

  summaryParts.push("### Session Summary (Auto-saved before overflow reset)\n");

  for (const msg of recentMessages) {
    if (msg.role === "user") {
      const content = typeof msg.content === "string" ? msg.content : "[complex]";
      const bodyMatch = content.match(/\] (.+)/s);
      const body = bodyMatch ? bodyMatch[1] : content;
      summaryParts.push(`- **User**: ${body.substring(0, 150)}${body.length > 150 ? "..." : ""}`);
    } else if (msg.role === "assistant") {
      const textBlocks = msg.content.filter((b): b is TextContent => b.type === "text");
      const toolBlocks = msg.content.filter((b): b is ToolCall => b.type === "toolCall");

      if (textBlocks.length > 0) {
        const text = textBlocks[0].text || "";
        summaryParts.push(
          `- **Agent**: ${text.substring(0, 150)}${text.length > 150 ? "..." : ""}`
        );
      }

      if (toolBlocks.length > 0) {
        const toolNames = toolBlocks.map((b) => b.name).join(", ");
        summaryParts.push(`  - *Tools used: ${toolNames}*`);
      }
    } else if (msg.role === "toolResult") {
      const status = msg.isError ? "ERROR" : "OK";
      summaryParts.push(`  - *Tool result: ${msg.toolName} → ${status}*`);
    }
  }

  return summaryParts.join("\n");
}

/**
 * Trims RAG context to `maxChars` to reduce token cost and response latency.
 * Returns the original string unchanged if `maxChars` is undefined or the
 * string is already within budget. When trimming occurs, appends a marker so
 * the model knows the context was truncated.
 */
export function trimRagContext(context: string, maxChars: number | undefined): string {
  if (maxChars === undefined || context.length <= maxChars) return context;
  return context.slice(0, maxChars) + "\n...[context trimmed]";
}

/**
 * Smart loop-stall detector for the agentic loop.
 *
 * Breaks only when the **same** set of tool-call signatures repeats
 * `threshold` times **consecutively** — not on the very first repeat.
 *
 * Why this is better than the previous "any repeat" approach:
 * - Legitimate re-use: the agent may read the same key after writing new
 *   data to it; the context has changed even though the call looks identical.
 * - Transient retries: a tool may fail on iteration N and succeed on N+1,
 *   so one repeat is normal and healthy.
 * - True infinite loops only happen when the agent is genuinely stuck and
 *   keeps issuing the exact same call iteration after iteration.
 *
 * The consecutive counter resets to 1 whenever a new signature set appears,
 * so interspersed fresh work clears the stall counter.
 */
export class LoopStallDetector {
  private lastSignatureKey: string = "";
  private consecutiveCount: number = 0;
  private readonly threshold: number;

  constructor(threshold: number) {
    this.threshold = threshold;
  }

  /**
   * Record the tool-call signatures for the current iteration.
   * Returns `true` if a stall is detected (loop should break).
   *
   * @param signatures - Sorted, stable string representations of each tool
   *   call (e.g. `"tool_name:{\"param\":\"value\"}"`)
   */
  record(signatures: string[]): boolean {
    if (signatures.length === 0) return false;

    const key = signatures.slice().sort().join("|");

    if (key === this.lastSignatureKey) {
      this.consecutiveCount++;
    } else {
      this.lastSignatureKey = key;
      this.consecutiveCount = 1;
    }

    return this.consecutiveCount >= this.threshold;
  }
}
