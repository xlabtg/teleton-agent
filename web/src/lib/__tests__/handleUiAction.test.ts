import { describe, expect, it, vi } from "vitest";
import { handleUiAction } from "../handleUiAction";

describe("handleUiAction", () => {
  it("surfaces a rejected action without rethrowing it", async () => {
    const setError = vi.fn();

    await expect(
      handleUiAction(() => Promise.reject(new Error("boom")), setError)
    ).resolves.toBeUndefined();

    expect(setError).toHaveBeenCalledOnce();
    expect(setError).toHaveBeenCalledWith("boom");
  });

  it("converts non-Error rejections to a readable message", async () => {
    const setError = vi.fn();

    await handleUiAction(() => Promise.reject("offline"), setError);

    expect(setError).toHaveBeenCalledWith("offline");
  });
});
