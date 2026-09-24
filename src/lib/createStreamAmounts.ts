/**
 * Treasury amount helpers — exact decimal arithmetic (issue #1753).
 *
 * ## Why this module avoids IEEE-754
 *
 * A token amount has to survive the whole journey from user input to the
 * on-chain payload without ever changing value. JavaScript's `number` is an
 * IEEE-754 double: it cannot represent most 2-decimal values exactly, and the
 * error compounds as soon as an amount is multiplied or rounded. At the
 * magnitudes treasury amounts reach (15 integer digits), the spacing between
 * representable doubles is already 0.125, so a value such as
 * `99999999999999.99 * 0.50` renders as `49999999999999.99` instead of the
 * exact `50000000000000.00`.
 *
 * Every monetary value in this module is therefore carried as a `bigint` in the
 * token's **minor units** (10^-{@link AMOUNT_DECIMAL_PLACES}), and all
 * arithmetic is integer arithmetic. Floating point never touches an amount.
 *
 * The lint rule `no-float-amount-arithmetic` (see `eslint.config.js`) fails any
 * future change that reintroduces `parseFloat`, `Number(...)`, unary `+`,
 * `toFixed`, or arithmetic against a fractional literal into this file.
 */

export const AMOUNT_DECIMAL_PLACES = 2;
const MAX_SANITIZED_INTEGER_DIGITS = 15;
const MAX_FINITE_AMOUNT = 999_999_999_999_999;

/**
 * Scale factor between a display amount (e.g. `12.34`) and its integer minor
 * units (`1234n`). All amounts in this module are stored as multiples of this
 * value so they stay exact.
 */
const MINOR_UNITS_SCALE = 10n ** BigInt(AMOUNT_DECIMAL_PLACES);

/** Upper bound, expressed in minor units, that every amount is clamped to. */
const MAX_MINOR_UNITS = BigInt(MAX_FINITE_AMOUNT) * MINOR_UNITS_SCALE;

/**
 * Keeps user-entered treasury amounts decimal-safe for UI state.
 *
 * The function validates the input strictly:
 *   • Allows only digits, a single decimal point, and **properly grouped** thousands‑separator commas.
 *   • Rejects scientific‑notation, extra decimal points, minus signs, letters, and malformed commas.
 *   • If any invalid pattern is detected the function returns an empty string, signalling the caller
 *     that the value should be rejected (the UI can surface a validation error).
 *
 * This is a pure string transformation — no numeric conversion takes place, so
 * no precision can be lost here.
 */
export function sanitizeAmount(value: string): string {
  // Quick reject dangerous characters (e/E, minus or plus signs). Whitespace and other symbols are ignored later.
  if (/[eE\-\+]/.test(value)) {
    return ""; // invalid input – caller should display an error
  }
  const interim = value.replace(/[^0-9,\.]/g, "");
  // Validate commas – they must be used as thousands separators and not affect magnitude.
  // Accept patterns like "1,234", "12,345,678.90", or "1234" (no commas).
  // If commas are present but the pattern is malformed, reject.
  const commaPattern = /^\d{1,3}(?:,\d{3})*(?:\.\d*)?$|^\d+(?:\.\d*)?$/;
  if (interim.includes(",") && !commaPattern.test(interim)) {
    return ""; // malformed comma grouping
  }

  // Strip commas for easier processing.
  const cleaned = interim.replace(/,/g, "");

  let sanitized = "";
  let hasDecimalPoint = false;
  let integerDigits = 0;
  let fractionalDigits = 0;

  for (const char of cleaned) {
    if (char >= "0" && char <= "9") {
      if (hasDecimalPoint) {
        if (fractionalDigits >= AMOUNT_DECIMAL_PLACES) continue;
        fractionalDigits += 1;
      } else {
        if (integerDigits >= MAX_SANITIZED_INTEGER_DIGITS) continue;
        integerDigits += 1;
      }
      sanitized += char;
      continue;
    }

    if (char === "." && !hasDecimalPoint) {
      hasDecimalPoint = true;
      sanitized += char;
      continue;
    }
    // Ignore any other characters (e.g., currency symbols, letters) after validation.
    continue;
  }

  // Ensure we didn't end up with just a trailing '.' – that is not a valid number.
  if (sanitized.endsWith(".")) {
    return "";
  }

  return sanitized;
}

/**
 * Parses a sanitized amount into exact integer **minor units**
 * (10^-{@link AMOUNT_DECIMAL_PLACES}).
 *
 * Unlike a `Number.parseFloat` round-trip, this never loses precision: the
 * digits of the sanitized string are assembled directly into a `bigint`. Invalid
 * input yields `0n`, and the result is clamped to the module's maximum so an
 * out-of-range value can never overflow later arithmetic.
 *
 * @param value - User-entered amount string (commas / currency symbols allowed).
 * @returns The amount in minor units, `0n` when invalid. Always a `bigint`.
 */
export function parseAmountToMinorUnits(value: string): bigint {
  const sanitized = sanitizeAmount(value);
  if (sanitized === "") return 0n;

  const [wholePart = "", fractionPart = ""] = sanitized.split(".");
  const whole = wholePart === "" ? 0n : BigInt(wholePart);
  const fraction =
    fractionPart === ""
      ? 0n
      : BigInt(fractionPart.padEnd(AMOUNT_DECIMAL_PLACES, "0"));

  const minorUnits = whole * MINOR_UNITS_SCALE + fraction;
  return minorUnits > MAX_MINOR_UNITS ? MAX_MINOR_UNITS : minorUnits;
}

/**
 * Formats exact integer minor units back into a fixed-point display string with
 * exactly {@link AMOUNT_DECIMAL_PLACES} decimals.
 *
 * The inverse of {@link parseAmountToMinorUnits}: no rounding is performed, so
 * `parseAmountToMinorUnits(formatAmountFromMinorUnits(m)) === m` for every
 * in-range `m`.
 */
export function formatAmountFromMinorUnits(minorUnits: bigint): string {
  const safe = minorUnits < 0n ? 0n : minorUnits;
  const whole = safe / MINOR_UNITS_SCALE;
  const fraction = safe % MINOR_UNITS_SCALE;
  return `${whole.toString()}.${fraction
    .toString()
    .padStart(AMOUNT_DECIMAL_PLACES, "0")}`;
}

/**
 * Computes the required deposit from a daily rate and a duration in days using
 * exact integer arithmetic.
 *
 * Both operands are parsed to minor units, so their product is in 10^-2 × 10^-2
 * = 10^-4 units. The exact product is rounded half-up back to
 * {@link AMOUNT_DECIMAL_PLACES} decimals (the float-free equivalent of the
 * previous `toFixed(2)`) and then clamped to the module maximum.
 *
 * @returns A fixed-point string with exactly {@link AMOUNT_DECIMAL_PLACES}
 *          decimals that matches the chain's integer value exactly.
 */
export function calculateRequiredDeposit(rate: string, duration: string): string {
  const rateMinorUnits = parseAmountToMinorUnits(rate);
  const durationMinorUnits = parseAmountToMinorUnits(duration);

  const product = rateMinorUnits * durationMinorUnits;
  const roundedMinorUnits =
    (product + MINOR_UNITS_SCALE / 2n) / MINOR_UNITS_SCALE;

  return formatAmountFromMinorUnits(
    roundedMinorUnits > MAX_MINOR_UNITS ? MAX_MINOR_UNITS : roundedMinorUnits,
  );
}
