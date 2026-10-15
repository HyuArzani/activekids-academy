/**
 * Safe Indonesian rupiah formatter.
 *
 * The API returns monetary totals as strings (e.g., "400000.00") to
 * preserve numeric(12,2) precision. This formatter parses the string
 * without going through `parseFloat` (which can lose precision for
 * large amounts) and formats it as "Rp 400.000".
 *
 * Uses BigInt internally to avoid any floating-point precision loss.
 * (BigInt(100) instead of 100n literal — tsconfig target is < ES2020.)
 *
 * Handles:
 *   - Whole-number strings: "400000" → "Rp 400.000"
 *   - Two-decimal strings: "400000.00" → "Rp 400.000"
 *   - Zero: "0.00" → "Rp 0"
 *   - Negative amounts: "-50000.00" → "-Rp 50.000"
 *
 * Uses the `id-ID` locale via `Intl.NumberFormat` for correct thousands
 * grouping (dot separator, per Indonesian convention).
 */

const HUNDRED = BigInt(100);
const ZERO = BigInt(0);

export function formatRupiah(amount: string): string {
  // Parse the string into integer minor units (sen) to avoid float
  // precision loss. Split on the decimal point.
  const negative = amount.trim().startsWith("-");
  const clean = negative ? amount.trim().slice(1) : amount.trim();
  const [wholePart, decimalPart = "00"] = clean.split(".");
  const paddedDecimal = (decimalPart ?? "").padEnd(2, "0").slice(0, 2);

  // Combine into a single integer of minor units (BigInt for safety).
  const wholeBigInt = BigInt(wholePart || "0");
  const minorUnits = wholeBigInt * HUNDRED + BigInt(paddedDecimal || "0");

  // If the amount is zero, return "Rp 0".
  if (minorUnits === ZERO) {
    return "Rp 0";
  }

  // Format the major units with Indonesian thousands grouping.
  const majorUnits = minorUnits / HUNDRED;
  const formattedMajor = new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: 0,
  }).format(Number(majorUnits));

  // Only show decimals if there are non-zero sen.
  const sen = minorUnits % HUNDRED;
  const suffix = sen > ZERO ? `,${sen.toString().padStart(2, "0")}` : "";

  const result = `Rp ${formattedMajor}${suffix}`;
  return negative ? `-${result}` : result;
}
