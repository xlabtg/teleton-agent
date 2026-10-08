import { afterEach, describe, expect, it, vi } from "vitest";
import { withFloodRetry } from "../flood-retry.js";

afterEach(() => vi.useRealTimers());
describe("nested flood retry budget (#761)", () => {
  it("makes only three API attempts across nested wrappers", async () => {
    vi.useFakeTimers();
    const api = vi.fn(async () => {
      throw Object.assign(new Error("FLOOD_WAIT"), { seconds: 1 });
    });
    const result = withFloodRetry(() => withFloodRetry(api)).catch((error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBeInstanceOf(Error);
    expect(api).toHaveBeenCalledTimes(3);
  });
});
