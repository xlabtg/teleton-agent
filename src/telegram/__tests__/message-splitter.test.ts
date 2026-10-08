import { describe, it, expect } from "vitest";
import { splitMessageForTelegram } from "../message-splitter";

const LIMIT = 4096;

describe("splitMessageForTelegram", () => {
  it("returns single element for short messages", () => {
    const text = "Hello, world!";
    const parts = splitMessageForTelegram(text);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(text);
  });

  it("returns single element for message exactly at limit", () => {
    const text = "a".repeat(LIMIT);
    const parts = splitMessageForTelegram(text);
    expect(parts).toHaveLength(1);
  });

  it("splits message longer than limit", () => {
    const text = "a".repeat(LIMIT + 1);
    const parts = splitMessageForTelegram(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(LIMIT);
    }
  });

  it("splits at double newline when available", () => {
    const para1 = "First paragraph. ".repeat(100); // ~1700 chars
    const para2 = "Second paragraph. ".repeat(100); // ~1800 chars
    const para3 = "Third paragraph. ".repeat(100); // ~1700 chars
    const text = para1.trimEnd() + "\n\n" + para2.trimEnd() + "\n\n" + para3.trimEnd();
    const parts = splitMessageForTelegram(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(LIMIT);
    }
    // Reassembled text should contain all the content
    const reassembled = parts.join(" ");
    expect(reassembled).toContain("First paragraph");
    expect(reassembled).toContain("Second paragraph");
    expect(reassembled).toContain("Third paragraph");
  });

  it("splits at single newline when no double newlines", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Line number ${i + 1} with some content.`);
    const text = lines.join("\n");
    const parts = splitMessageForTelegram(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(LIMIT);
    }
  });

  it("each part is within the limit", () => {
    const text = "word ".repeat(3000); // ~15000 chars
    const parts = splitMessageForTelegram(text);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(LIMIT);
    }
  });

  it("combined parts contain all original content words", () => {
    const words = Array.from({ length: 1000 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    const parts = splitMessageForTelegram(text);
    const combined = parts.join(" ");
    for (const word of words) {
      expect(combined).toContain(word);
    }
  });

  it("does not split inside a fenced code block if avoidable", () => {
    const preamble = "Here is some code:\n\n";
    const codeBlock = "```python\ndef hello():\n    print('hello')\n```\n\n";
    // Make preamble long enough that it pushes the code block near the boundary
    const longPreamble = "x".repeat(LIMIT - codeBlock.length - 50) + "\n\n";
    const text = longPreamble + codeBlock + "Some text after.";
    const parts = splitMessageForTelegram(text);
    // Code block should be intact in one of the parts
    const codeBlockInPart = parts.some((p) => p.includes("```python") && p.includes("```"));
    expect(codeBlockInPart).toBe(true);
  });

  it("handles empty string", () => {
    const parts = splitMessageForTelegram("");
    // Should return one empty part or empty array — either is acceptable
    expect(Array.isArray(parts)).toBe(true);
  });

  it("respects custom maxLength", () => {
    const text = "Hello world. ".repeat(20); // ~260 chars
    const parts = splitMessageForTelegram(text, 100);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(100);
    }
  });
});

it.each([1, 2, 10, 4096])("preserves Unicode code points at limit %s (#765)", (limit) => {
  const text = "a" + "😀".repeat(2100);
  const parts = splitMessageForTelegram(text, limit);
  expect(parts.join("")).toBe(text);
  for (const part of parts) {
    expect(part.isWellFormed()).toBe(true);
    expect(part.length).toBeLessThanOrEqual(Math.max(2, limit));
  }
});

it("retains the requested one-unit limit for ordinary characters", () => {
  expect(splitMessageForTelegram("abc", 1)).toEqual(["a", "b", "c"]);
});
