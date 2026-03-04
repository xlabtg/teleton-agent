import { createLogger } from "../utils/logger.js";

const log = createLogger("Telegram");

const DEFAULT_MAX_WAIT_SECONDS = 120;
const DEFAULT_MAX_RETRIES = 2;

export async function withFloodRetry<T>(
  fn: () => Promise<T>,
  maxWaitSeconds = DEFAULT_MAX_WAIT_SECONDS,
  maxRetries = DEFAULT_MAX_RETRIES
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const waitSeconds = (error as Record<string, unknown>).seconds;

      if (typeof waitSeconds !== "number") {
        throw error;
      }

      lastError = error as Error;

      if (waitSeconds > maxWaitSeconds) {
        throw new Error(`FLOOD_WAIT ${waitSeconds}s exceeds max ${maxWaitSeconds}s — aborting`);
      }

      if (attempt >= maxRetries) break;

      log.warn(`[FLOOD_WAIT] Waiting ${waitSeconds}s before retry ${attempt + 1}/${maxRetries}`);
      await new Promise((r) => setTimeout(r, waitSeconds * 1000));
    }
  }

  throw lastError ?? new Error("FLOOD_WAIT retries exhausted");
}
