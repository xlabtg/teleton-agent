import { describe, expect, it } from "vitest";
import { splitTelegramHtml } from "../html-splitter";

function expectBalanced(chunks: string[], maxLength: number): void {
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(maxLength);
    expect(chunk.match(/<b>/g)?.length ?? 0).toBe(chunk.match(/<\/b>/g)?.length ?? 0);
    expect(chunk).not.toMatch(/&(?:#\d*|#x[\da-f]*|[a-z]*)$/i);
  }
}

describe("splitTelegramHtml", () => {
  it("rejects a non-positive limit even for short input", () => {
    expect(() => splitTelegramHtml("short", 0)).toThrow(RangeError);
  });

  it("closes and reopens formatting that spans a chunk boundary", () => {
    const chunks = splitTelegramHtml(`<b>${"word ".repeat(30)}</b>`, 50);

    expect(chunks.length).toBeGreaterThan(1);
    expectBalanced(chunks, 50);
    expect(chunks.every((chunk) => chunk.startsWith("<b>") && chunk.endsWith("</b>"))).toBe(true);
  });

  it("never splits an HTML entity", () => {
    const chunks = splitTelegramHtml(`prefix ${"x".repeat(10)} &amp; suffix`, 20);

    expect(chunks.join("")).toContain("&amp;");
    expectBalanced(chunks, 20);
  });

  it("accounts for entities when the rendered text expands beyond the limit", () => {
    const chunks = splitTelegramHtml("&amp;".repeat(20), 21);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe("&amp;".repeat(20));
    expectBalanced(chunks, 21);
  });

  it("keeps nested tags and astral characters intact", () => {
    const chunks = splitTelegramHtml(`<b><i>${"🙂".repeat(30)}</i></b>`, 35);

    expectBalanced(chunks, 35);
    expect(chunks.some((chunk) => chunk.includes("�"))).toBe(false);
    expect(chunks.every((chunk) => chunk.includes("<b>") && chunk.includes("<i>"))).toBe(true);
  });

  it("preserves link attributes when reopening a tag", () => {
    const opening = '<a href="https://example.com?a=1&amp;b=2">';
    const chunks = splitTelegramHtml(`${opening}${"link text ".repeat(20)}</a>`, 80);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith(opening) && chunk.endsWith("</a>"))).toBe(true);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
  });
});
