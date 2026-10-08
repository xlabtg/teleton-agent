import { describe, it, expect } from "vitest";
import { toUnits } from "../units.js";

describe("decimal unit conversion (#748)", () => {
  it.each([
    [0.1, 18, "100000000000000000"],
    [0.3, 18, "300000000000000000"],
    [1e21, 9, "1000000000000000000000000000000"],
    [1e-7, 9, "100"],
    [-0.3, 18, "-300000000000000000"],
    [1.99, 0, "1"],
  ])("converts %s at %s decimals", (amount, decimals, expected) => {
    expect(toUnits(Number(amount), Number(decimals)).toString()).toBe(expected);
  });
  it("supports all TEP-64 decimals", () => {
    expect(toUnits(0.1, 255)).toBe(10n ** 254n);
    expect(() => toUnits(Infinity, 9)).toThrow();
    expect(() => toUnits(1, 256)).toThrow();
  });
});
