---
title: "[AUDIT/V7] Bot bridge splits/truncates already-rendered HTML on whitespace boundaries, producing unbalanced tags that Telegram rejects"
labels: ["bug", "audit-finding-v7", "medium", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-018"
severity: "medium"
category: "reliability"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/708"
---

## Problem Description

`sendLongMessage` splits a message that is **already rendered to Telegram HTML** by
looking for `\n\n` / `\n` / space boundaries (or a hard character cut), without any
awareness of HTML tag or entity boundaries:

```ts
// src/telegram/bridges/bot.ts:153-168
while (remaining.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
  let splitAt = remaining.lastIndexOf("\n\n", TELEGRAM_MAX_MESSAGE_LENGTH);
  ...
  if (splitAt < TELEGRAM_MAX_MESSAGE_LENGTH * 0.3) splitAt = TELEGRAM_MAX_MESSAGE_LENGTH; // hard cut
  chunks.push(remaining.slice(0, splitAt));
  remaining = remaining.slice(splitAt).trimStart();
}
```

A whitespace split can land **between** an opening and closing tag (e.g. inside
`<b>…</b>`, `<a href="…">…</a>`, `<pre>`/`<code>` blocks), leaving one chunk with an
unclosed tag and the next with a stray closing tag. Sent with `parse_mode: HTML`,
Telegram rejects the chunk (`Bad Request: can't parse entities`) or the message
renders corrupted. The hard-cut fallback can also slice through a multi-byte HTML
entity (`&amp;`, `&#…;`).

The guest-query path has the same defect with a blind truncation:

```ts
// src/telegram/bridges/bot.ts:549
const html = markdownToTelegramHtml(text).slice(0, TELEGRAM_MAX_MESSAGE_LENGTH);
```

## Location

- `src/telegram/bridges/bot.ts:144-168` — `sendLongMessage` splits rendered HTML on
  whitespace/hard-cut boundaries.
- `src/telegram/bridges/bot.ts:126-127` — entry that routes long HTML into it.
- `src/telegram/bridges/bot.ts:549` — guest path `.slice(0, MAX)` on rendered HTML.

## How To Reproduce

1. Produce a reply longer than `TELEGRAM_MAX_MESSAGE_LENGTH` that contains formatting
   spanning a natural split point (e.g. a long bulleted list wrapped in `<b>`/links).
2. Send it; a chunk boundary falls inside a tag → Telegram returns a parse error or
   the chunk renders with broken/mismatched formatting.

## Impact

Long formatted replies intermittently fail to send or render corrupted, depending on
where tags happen to fall relative to the split point — user-visible message loss /
garbling that is hard to reproduce deterministically.

## Proposed Fix

Split on the *source* (Markdown/plain text) before rendering, or make the splitter
HTML-aware: never cut inside a tag or entity, and re-balance open tags across chunk
boundaries (close them at the end of a chunk and reopen at the start of the next).
For the guest path, truncate the source and re-render rather than slicing rendered
HTML.

## Regression Test

```typescript
it("never splits inside an HTML tag or entity", () => {
  const html = "<b>" + "x ".repeat(3000) + "</b>";   // exceeds MAX with formatting
  for (const chunk of splitForTelegram(html)) {
    expect(isBalancedHtml(chunk)).toBe(true);
  }
});
```

## Acceptance Criteria

- [ ] No chunk contains an unbalanced/truncated HTML tag or entity.
- [ ] Long formatted messages send successfully with `parse_mode: HTML`.
- [ ] The guest-query path does not slice rendered HTML mid-tag.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-018`
- Modules: `src/telegram/bridges/bot.ts`
