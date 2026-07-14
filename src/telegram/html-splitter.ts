import { TELEGRAM_MAX_MESSAGE_LENGTH } from "../constants/limits.js";

interface OpenTag {
  name: string;
  opening: string;
}

interface Token {
  value: string;
  kind: "tag" | "entity" | "text";
}

const VOID_TAGS = new Set(["br"]);

/** Split Telegram HTML without cutting entities or leaving formatting tags unbalanced. */
export function splitTelegramHtml(
  html: string,
  maxLength: number = TELEGRAM_MAX_MESSAGE_LENGTH
): string[] {
  if (maxLength <= 0) throw new RangeError("maxLength must be positive");
  if (html.length <= maxLength) return [html];

  const chunks: string[] = [];
  const openTags: OpenTag[] = [];
  let chunk = "";

  const closingTags = (): string =>
    [...openTags]
      .reverse()
      .map(({ name }) => `</${name}>`)
      .join("");

  const reopenTags = (): string => openTags.map(({ opening }) => opening).join("");

  const flush = (): void => {
    if (chunk.length === 0) return;
    chunks.push(chunk + closingTags());
    chunk = reopenTags();
  };

  for (const token of tokenize(html)) {
    let value = token.value;

    while (value.length > 0) {
      const reserved = closingTags().length;
      const available = maxLength - chunk.length - reserved;

      if (value.length <= available) {
        chunk += value;
        value = "";
        continue;
      }

      if (token.kind !== "text") {
        if (chunk.length === reopenTags().length) {
          throw new RangeError("HTML formatting overhead leaves no room for content");
        }
        flush();
        if (value.length + closingTags().length > maxLength) {
          throw new RangeError("An HTML token is longer than maxLength");
        }
        continue;
      }

      if (available <= 0) {
        flush();
        continue;
      }

      const splitAt = findTextSplit(value, available);
      chunk += value.slice(0, splitAt);
      value = value.slice(splitAt);
      flush();
    }

    if (token.kind === "tag") {
      updateOpenTags(token.value, openTags);
      if (chunk.length + closingTags().length > maxLength) {
        throw new RangeError("HTML formatting tags are longer than maxLength");
      }
    }
  }

  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /<[^>]*>|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/gi;
  let offset = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    if (match.index > offset) {
      tokens.push({ value: html.slice(offset, match.index), kind: "text" });
    }
    tokens.push({
      value: match[0],
      kind: match[0].startsWith("<") ? "tag" : "entity",
    });
    offset = pattern.lastIndex;
  }

  if (offset < html.length) tokens.push({ value: html.slice(offset), kind: "text" });
  return tokens;
}

function updateOpenTags(tag: string, openTags: OpenTag[]): void {
  const closing = tag.match(/^<\/\s*([\w-]+)\s*>$/);
  if (closing) {
    const name = closing[1].toLowerCase();
    const index = openTags.map((item) => item.name).lastIndexOf(name);
    if (index >= 0) openTags.splice(index, 1);
    return;
  }

  const opening = tag.match(/^<\s*([\w-]+)(?:\s[^>]*)?>$/);
  if (!opening || tag.endsWith("/>") || VOID_TAGS.has(opening[1].toLowerCase())) return;
  openTags.push({ name: opening[1].toLowerCase(), opening: tag });
}

function findTextSplit(text: string, available: number): number {
  const prefix = text.slice(0, available);
  const candidates = [
    prefix.lastIndexOf("\n\n"),
    prefix.lastIndexOf("\n"),
    prefix.lastIndexOf(" "),
  ];
  const natural = candidates.find((index) => index >= available * 0.3);
  let splitAt = natural === undefined ? available : natural + 1;

  const lastCodeUnit = text.charCodeAt(splitAt - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) splitAt--;
  return Math.max(splitAt, 1);
}
