// Exact decimal intermediates for non-negative prices. Number conversion only
// happens when returning a result, so e.g. 0.00004 * 1056 does not acquire a
// floating-point tail that would round a later usage charge up unnecessarily.
type DecimalFraction = {
  numerator: bigint;
  denominator: bigint;
};

export function decimalFraction(value: number | string): DecimalFraction {
  const [significand, exponent = "0"] = value.toString().toLowerCase().split("e");
  const [integer, fraction = ""] = significand.split(".");
  const scale = fraction.length - Number(exponent);
  const coefficient = BigInt(integer + fraction);
  return scale >= 0
    ? { numerator: coefficient, denominator: BigInt(10) ** BigInt(scale) }
    : {
        numerator: coefficient * BigInt(10) ** BigInt(-scale),
        denominator: BigInt(1),
      };
}

/** Parse untrusted non-negative decimal amounts without a Number round-trip. */
export function parseNonNegativeDecimalFraction(value: unknown): DecimalFraction | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? decimalFraction(value) : null;
  }
  // Bound both the coefficient and exponent before constructing BigInts. This
  // still exceeds the precision/range of every finite JavaScript number.
  if (typeof value !== "string" || value.length > 1024) return null;
  const decimal = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(decimal)) return null;
  const exponent = Number(decimal.split(/[eE]/)[1] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1024) return null;
  const fraction = decimalFraction(decimal);
  return fraction.numerator >= BigInt(0) ? fraction : null;
}

function fractionToNumber(numerator: bigint, denominator: bigint): number {
  // Every denominator is a power of ten. Parsing the decimal string avoids
  // rounding either side of the fraction through Number before division.
  return Number(`${numerator}e-${denominator.toString().length - 1}`);
}

export function multiplyDecimalAmounts(...values: number[]): number {
  if (values.some((value) => !Number.isFinite(value) || value < 0))
    return Number.NaN;
  let numerator = BigInt(1);
  let denominator = BigInt(1);
  for (const value of values) {
    const fraction = decimalFraction(value);
    numerator *= fraction.numerator;
    denominator *= fraction.denominator;
  }
  return fractionToNumber(numerator, denominator);
}

export function addDecimalAmounts(left: number, right: number): number {
  if (![left, right].every((value) => Number.isFinite(value) && value >= 0))
    return Number.NaN;
  const a = decimalFraction(left);
  const b = decimalFraction(right);
  return fractionToNumber(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}
