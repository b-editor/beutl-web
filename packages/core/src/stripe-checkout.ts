type StripeCheckoutAmounts = {
  amountSubtotal: number | null | undefined;
  amountTotal: number | null | undefined;
};

export function allowsStripePromotionCodes(params: unknown): boolean {
  let value = params;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { allow_promotion_codes?: unknown }).allow_promotion_codes === true
  );
}

export function isValidStripeCheckoutAmount(
  amount: number,
  undiscountedAmount: number,
  promotionCodesEnabled: boolean,
): boolean {
  return (
    Number.isSafeInteger(amount) &&
    amount > 0 &&
    Number.isSafeInteger(undiscountedAmount) &&
    undiscountedAmount > 0 &&
    amount <= undiscountedAmount &&
    (amount === undiscountedAmount || promotionCodesEnabled)
  );
}

export function isValidStripeCheckoutSessionAmount(
  { amountSubtotal, amountTotal }: StripeCheckoutAmounts,
  undiscountedAmount: number,
  promotionCodesEnabled: boolean,
  allowMissingAmounts = false,
): boolean {
  if (!Number.isSafeInteger(undiscountedAmount) || undiscountedAmount <= 0) {
    return false;
  }
  if (amountSubtotal === null || amountSubtotal === undefined) {
    if (amountTotal === null || amountTotal === undefined) {
      return allowMissingAmounts;
    }
    // Older Session fixtures and records may not have retained the subtotal.
    // Without it, only the undiscounted total proves the configured Price.
    return amountTotal === undiscountedAmount;
  }
  if (amountSubtotal !== undiscountedAmount) {
    return false;
  }
  if (amountTotal === null || amountTotal === undefined) {
    return allowMissingAmounts;
  }
  return isValidStripeCheckoutAmount(
    amountTotal,
    undiscountedAmount,
    promotionCodesEnabled,
  );
}

export function isZeroCostStripeCheckoutSessionAmount(
  { amountSubtotal, amountTotal }: StripeCheckoutAmounts,
  undiscountedAmount: number,
  promotionCodesEnabled: boolean,
): boolean {
  return (
    promotionCodesEnabled &&
    Number.isSafeInteger(undiscountedAmount) &&
    undiscountedAmount > 0 &&
    amountSubtotal === undiscountedAmount &&
    amountTotal === 0
  );
}
