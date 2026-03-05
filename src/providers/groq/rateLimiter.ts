/**
 * Groq Rate Limiter
 *
 * Implements a token-bucket style rate limiter for the Groq Free Plan.
 * Handles 429 (Too Many Requests) with exponential backoff retries,
 * and distinguishes 403 (Forbidden/Auth error) from 429 (Rate limit).
 */

import { createLogger } from "../../utils/logger.js";

const log = createLogger("GroqRateLimiter");

/** Estimate token count from text (rough approximation: 1 token ≈ 4 chars) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Groq-specific error types */
export type GroqErrorType = "rate_limit" | "auth_error" | "server_error" | "unknown";

/** Parse error type from HTTP response status */
export function parseGroqErrorType(status: number): GroqErrorType {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth_error";
  if (status >= 500) return "server_error";
  return "unknown";
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
};

/**
 * Execute a function with automatic retry on 429 rate-limit errors.
 * Uses exponential backoff with jitter.
 */
export async function withGroqRateLimit<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const { maxRetries, initialDelayMs, maxDelayMs } = { ...DEFAULT_RETRY_OPTIONS, ...options };

  let lastError: Error | undefined;
  let delayMs = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isRateLimit =
        errMsg.includes("429") ||
        errMsg.toLowerCase().includes("rate limit") ||
        errMsg.toLowerCase().includes("too many requests");

      if (!isRateLimit || attempt === maxRetries) {
        throw err;
      }

      // Extract retry-after from error message if available
      const retryAfterMatch = errMsg.match(/retry.after[:\s]+(\d+)/i);
      const retryAfterMs = retryAfterMatch ? Number(retryAfterMatch[1]) * 1000 : null;

      const waitMs = retryAfterMs ?? Math.min(delayMs * (1 + Math.random() * 0.1), maxDelayMs);
      log.warn(
        `Groq rate limit hit (attempt ${attempt + 1}/${maxRetries}), waiting ${Math.round(waitMs)}ms...`
      );

      await sleep(waitMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
      lastError = err instanceof Error ? err : new Error(errMsg);
    }
  }

  throw lastError ?? new Error("Groq rate limit exceeded after retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
