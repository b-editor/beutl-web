const zeroDecimalCurrencies = [
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
];

export function isZeroDecimalCurrency(currency: string): boolean {
  return zeroDecimalCurrencies.includes(currency.toUpperCase());
}

export function formatAmount(amount: number, currency: string, lang: string) {
  const formatter = new Intl.NumberFormat(lang, {
    style: "currency",
    currency: currency,
  });

  if (isZeroDecimalCurrency(currency)) {
    return formatter.format(amount);
  } else {
    return formatter.format(amount / 100);
  }
}

// A derived per-unit rate is rarely a whole minor unit: ¥1,480 spread over a
// 500 unit allowance is ¥2.96 each. formatAmount would round that to ¥3 for a
// zero-decimal currency and make a cost ratio look wrong, so keep the extra
// digits here. Amounts charged to a customer still go through formatAmount.
export function formatFractionalAmount(
  minorUnits: number,
  currency: string,
  lang: string,
  { extraFractionDigits = 2 }: { extraFractionDigits?: number } = {},
): string {
  const zeroDecimal = isZeroDecimalCurrency(currency);
  const digits = (zeroDecimal ? 0 : 2) + extraFractionDigits;
  return new Intl.NumberFormat(lang, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(zeroDecimal ? minorUnits : minorUnits / 100);
}
