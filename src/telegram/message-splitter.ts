import { TELEGRAM_MAX_MESSAGE_LENGTH } from "../constants/limits.js";

/**
 * Splits a long message into parts suitable for Telegram, respecting the 4096-character limit.
 * Tries to split at natural break points: double newlines, single newlines, then spaces.
 * Never splits inside a code block to avoid broken formatting.
 *
 * @param text    The raw text to split (before HTML conversion).
 * @param maxLength Maximum characters per part (default: TELEGRAM_MAX_MESSAGE_LENGTH = 4096).
 * @returns Array of message parts, each within the character limit.
 */
export function splitMessageForTelegram(
  text: string,
  maxLength: number = TELEGRAM_MAX_MESSAGE_LENGTH
): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new Error("Invalid message length");
  if (text.length <= maxLength) {
    return [text];
  }

  const parts: string[] = [];

  while (text.length > maxLength) {
    // Try to find a split point that doesn't break a code block.
    // First check if we're inside a code block at position maxLength.
    const chunk = text.slice(0, maxLength);
    // A code point is indivisible even when maxLength=1; other characters keep that limit.
    const splitIndex =
      findSafeSplitIndex(chunk, maxLength) ||
      (text.charCodeAt(1) >= 0xdc00 && text.charCodeAt(1) <= 0xdfff ? 2 : 1);

    parts.push(text.slice(0, splitIndex).trimEnd());
    text = text.slice(splitIndex).trimStart();
  }

  if (text.length > 0) {
    parts.push(text);
  }

  return parts;
}

/**
 * Find a safe index to split the text, preferring natural line breaks
 * and avoiding splitting inside fenced code blocks.
 */
function findSafeSplitIndex(chunk: string, maxLength: number): number {
  // Count backtick fences up to each position; if we're inside a code block,
  // try to go back past its opening fence instead of splitting mid-block.
  const fencePositions = findCodeFencePositions(chunk);
  const insideCodeBlock = fencePositions.length % 2 !== 0;

  if (insideCodeBlock && fencePositions.length > 0) {
    // Split just before the opening fence of the current code block
    const lastOpenFence = fencePositions[fencePositions.length - 1];
    if (lastOpenFence > 0) {
      // Find a line break just before the opening fence
      const beforeFence = chunk.slice(0, lastOpenFence);
      const nlIdx = beforeFence.lastIndexOf("\n");
      if (nlIdx > maxLength * 0.3) {
        return nlIdx + 1;
      }
      if (lastOpenFence > maxLength * 0.3) {
        return lastOpenFence;
      }
    }
  }

  // Try double newline (paragraph break)
  let idx = chunk.lastIndexOf("\n\n");
  if (idx > maxLength * 0.5) {
    return idx + 2;
  }

  // Try single newline
  idx = chunk.lastIndexOf("\n");
  if (idx > maxLength * 0.3) {
    return idx + 1;
  }

  // Try space
  idx = chunk.lastIndexOf(" ");
  if (idx > maxLength * 0.3) {
    return idx + 1;
  }

  // Hard cut as last resort
  const last = chunk.charCodeAt(maxLength - 1);
  return last >= 0xd800 && last <= 0xdbff ? maxLength - 1 : maxLength;
}

/**
 * Returns start positions (in characters) of each ``` fence found in the text.
 * Positions are returned in order of appearance.
 */
function findCodeFencePositions(text: string): number[] {
  const positions: number[] = [];
  const pattern = /```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    positions.push(match.index);
  }
  return positions;
}
