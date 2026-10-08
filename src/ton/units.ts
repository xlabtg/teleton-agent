/**
 * On-chain unit conversion helpers — pure, with no asset-cache/DEX dependency.
 *
 * String-based to avoid floating-point precision loss: an off-by-one on the
 * decimals here means lost funds, so keep a single tested definition that any
 * layer (SDK, DEX tools, jetton transfers) can import without coupling to DeDust.
 */

/** Convert a human amount to on-chain integer units (10^decimals). */
export function toUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount)) throw new Error("Amount must be finite");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Decimals must be an integer between 0 and 255");
  }
  const [mantissa, exponent = "0"] = String(Math.abs(amount)).split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const digits = whole + fraction;
  const shift = Number(exponent) - fraction.length + decimals;
  const scaled =
    shift >= 0 ? digits + "0".repeat(shift) : digits.slice(0, Math.max(0, digits.length + shift));
  const units = BigInt(scaled || "0");
  return amount < 0 ? -units : units;
}

/** Convert on-chain integer units back to a human amount. */
export function fromUnits(units: bigint, decimals: number): number {
  const factor = 10 ** decimals;
  return Number(units) / factor;
}
