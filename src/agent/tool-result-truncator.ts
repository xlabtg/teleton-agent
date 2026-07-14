/**
 * Truncates oversized tool results into a valid JSON summary.
 * Pure function — no side effects, no logging.
 */
export function truncateToolResult(
  result: { success: boolean; data?: unknown; error?: string },
  maxSize: number
): string {
  const resultText = JSON.stringify(result);
  if (resultText.length <= maxSize) return resultText;

  const data = result.data as Record<string, unknown> | undefined;
  if (data?.summary || data?.message) {
    return capSerializedResult(
      JSON.stringify({
        success: result.success,
        data: {
          summary: data.summary || data.message,
          _truncated: true,
          _originalSize: resultText.length,
          _message: "Full data truncated. Use limit parameter for smaller results.",
        },
      }),
      maxSize
    );
  }

  // Build a valid JSON summary instead of raw-slicing (which breaks JSON)
  const summarized: Record<string, unknown> = {
    _truncated: true,
    _originalSize: resultText.length,
    _message: "Full data truncated. Use limit parameter for smaller results.",
  };
  if (data && typeof data === "object") {
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        summarized[key] = `[${value.length} items]`;
      } else if (typeof value === "string" && value.length > 500) {
        summarized[key] = value.slice(0, 500) + "...[truncated]";
      } else {
        summarized[key] = value;
      }
    }
  }
  return capSerializedResult(
    JSON.stringify({ success: result.success, data: summarized }),
    maxSize
  );
}

function capSerializedResult(serialized: string, maxSize: number): string {
  if (serialized.length <= maxSize) return serialized;
  if (maxSize <= 0) return "";

  const minimal = JSON.stringify({ _truncated: true });
  if (minimal.length <= maxSize) return minimal;

  // JSON strings are the only valid JSON values representable at every positive size.
  if (maxSize === 1) return "0";
  return `"${"x".repeat(maxSize - 2)}"`;
}
