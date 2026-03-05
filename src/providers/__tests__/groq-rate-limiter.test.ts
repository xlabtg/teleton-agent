import { describe, it, expect, vi } from "vitest";
import { estimateTokens, parseGroqErrorType, withGroqRateLimit } from "../groq/rateLimiter.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("approximates tokens for short text", () => {
    // "hello" = 5 chars → ceil(5/4) = 2
    expect(estimateTokens("hello")).toBe(2);
  });

  it("approximates tokens for longer text", () => {
    const text = "a".repeat(100);
    // 100 chars → ceil(100/4) = 25
    expect(estimateTokens(text)).toBe(25);
  });

  it("rounds up for non-divisible lengths", () => {
    // 7 chars → ceil(7/4) = 2
    expect(estimateTokens("abcdefg")).toBe(2);
  });
});

describe("parseGroqErrorType", () => {
  it("returns rate_limit for 429", () => {
    expect(parseGroqErrorType(429)).toBe("rate_limit");
  });

  it("returns auth_error for 401", () => {
    expect(parseGroqErrorType(401)).toBe("auth_error");
  });

  it("returns auth_error for 403", () => {
    expect(parseGroqErrorType(403)).toBe("auth_error");
  });

  it("returns server_error for 500", () => {
    expect(parseGroqErrorType(500)).toBe("server_error");
  });

  it("returns server_error for 503", () => {
    expect(parseGroqErrorType(503)).toBe("server_error");
  });

  it("returns unknown for 200", () => {
    expect(parseGroqErrorType(200)).toBe("unknown");
  });

  it("returns unknown for 400", () => {
    expect(parseGroqErrorType(400)).toBe("unknown");
  });
});

describe("withGroqRateLimit", () => {
  it("returns the result of the function on success", async () => {
    const result = await withGroqRateLimit(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("re-throws non-rate-limit errors immediately", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("some other error (400)"));
    await expect(withGroqRateLimit(fn)).rejects.toThrow("some other error (400)");
    expect(fn).toHaveBeenCalledTimes(1); // no retries
  });

  it("retries on rate-limit error and eventually succeeds", async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.reject(new Error("429 Too Many Requests"));
      }
      return Promise.resolve("success");
    });

    const result = await withGroqRateLimit(fn, {
      maxRetries: 3,
      initialDelayMs: 1, // minimal delay for tests
      maxDelayMs: 10,
    });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after maxRetries exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("429 rate limit exceeded"));

    await expect(
      withGroqRateLimit(fn, {
        maxRetries: 2,
        initialDelayMs: 1,
        maxDelayMs: 10,
      })
    ).rejects.toThrow();

    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("detects rate limit from 'too many requests' message", async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("Too Many Requests"));
      }
      return Promise.resolve("ok");
    });

    const result = await withGroqRateLimit(fn, {
      maxRetries: 2,
      initialDelayMs: 1,
      maxDelayMs: 10,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
