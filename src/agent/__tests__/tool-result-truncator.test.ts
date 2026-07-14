import { describe, expect, it } from "vitest";

import { truncateToolResult } from "../tool-result-truncator.js";

describe("truncateToolResult", () => {
  it.each([
    {
      name: "nested objects",
      data: { nested: { payload: "x".repeat(10_000) } },
    },
    {
      name: "large maps",
      data: Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`key${index}`, index])),
    },
    {
      name: "large summaries",
      data: { summary: "x".repeat(10_000) },
    },
  ])("caps $name at maxSize", ({ data }) => {
    const maxSize = 2_000;

    const output = truncateToolResult({ success: true, data }, maxSize);

    expect(output.length).toBeLessThanOrEqual(maxSize);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it.each([0, 1, 2, 10, 100])("respects a maxSize of %i", (maxSize) => {
    const output = truncateToolResult(
      { success: true, data: { summary: "x".repeat(10_000) } },
      maxSize
    );

    expect(output.length).toBeLessThanOrEqual(maxSize);
  });
});
