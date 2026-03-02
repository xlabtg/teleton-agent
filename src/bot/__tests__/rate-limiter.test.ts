import { describe, it, expect, beforeEach, vi } from "vitest";
import { PluginRateLimiter } from "../rate-limiter.js";

describe("PluginRateLimiter", () => {
  let limiter: PluginRateLimiter;

  beforeEach(() => {
    limiter = new PluginRateLimiter();
  });

  it("allows actions under the limit", () => {
    for (let i = 0; i < 5; i++) {
      expect(() => limiter.check("cats", "inline", 5)).not.toThrow();
    }
  });

  it("throws when rate limit exceeded", () => {
    for (let i = 0; i < 5; i++) {
      limiter.check("cats", "inline", 5);
    }
    expect(() => limiter.check("cats", "inline", 5)).toThrow(
      /Rate limit exceeded for plugin "cats" action "inline"/
    );
  });

  it("slides the window — old entries expire", () => {
    vi.useFakeTimers();

    for (let i = 0; i < 5; i++) {
      limiter.check("cats", "inline", 5, 1000);
    }
    expect(() => limiter.check("cats", "inline", 5, 1000)).toThrow();

    // Advance past window
    vi.advanceTimersByTime(1001);

    // Should work again
    expect(() => limiter.check("cats", "inline", 5, 1000)).not.toThrow();

    vi.useRealTimers();
  });

  it("tracks plugins independently", () => {
    for (let i = 0; i < 5; i++) {
      limiter.check("cats", "inline", 5);
    }
    // cats is at limit
    expect(() => limiter.check("cats", "inline", 5)).toThrow();
    // dogs is unaffected
    expect(() => limiter.check("dogs", "inline", 5)).not.toThrow();
  });

  it("tracks actions independently", () => {
    for (let i = 0; i < 5; i++) {
      limiter.check("cats", "inline", 5);
    }
    // inline is at limit
    expect(() => limiter.check("cats", "inline", 5)).toThrow();
    // callback is unaffected
    expect(() => limiter.check("cats", "callback", 5)).not.toThrow();
  });
});
