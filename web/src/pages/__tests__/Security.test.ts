import { describe, expect, it } from "vitest";
import { formatApprovalParams } from "../../lib/formatApprovalParams";

describe("formatApprovalParams", () => {
  it("formats valid JSON approval params", () => {
    expect(formatApprovalParams('{"command":"ls"}')).toBe('{"command":"ls"}');
  });

  it("returns malformed approval params as raw text", () => {
    expect(formatApprovalParams("not json")).toBe("not json");
  });
});
