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

export function formatAmount(amount: number, currency: string, lang: string) {
  const formatter = new Intl.NumberFormat(lang, {
    style: "currency",
    currency: currency,
  });

  if (zeroDecimalCurrencies.includes(currency.toUpperCase())) {
    return formatter.format(amount);
  } else {
    return formatter.format(amount / 100);
  }
}
