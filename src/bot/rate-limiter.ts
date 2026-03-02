/**
 * Sliding window rate limiter for plugin bot actions.
 * In-memory, per-plugin, no external dependencies.
 */

export class PluginRateLimiter {
  private windows = new Map<string, number[]>();

  /**
   * Check if an action is allowed under the rate limit.
   * Throws if the limit is exceeded.
   *
   * @param pluginName - Plugin identifier
   * @param action - Action type (e.g. "inline", "callback")
   * @param limit - Max actions per window
   * @param windowMs - Window duration in ms (default: 60000)
   */
  check(pluginName: string, action: string, limit: number, windowMs = 60_000): void {
    const key = `${pluginName}:${action}`;
    const now = Date.now();
    const cutoff = now - windowMs;

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Remove expired entries
    const firstValid = timestamps.findIndex((t) => t > cutoff);
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    } else if (firstValid === -1) {
      timestamps.length = 0;
    }

    if (timestamps.length >= limit) {
      throw new Error(
        `Rate limit exceeded for plugin "${pluginName}" action "${action}": ${limit} per ${windowMs / 1000}s`
      );
    }

    timestamps.push(now);
  }

  /** Clear all rate limit windows (for testing) */
  clear(): void {
    this.windows.clear();
  }
}
