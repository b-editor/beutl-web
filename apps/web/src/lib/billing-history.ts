export function packagePaymentReversalTranslationKey(payment: {
  revokedAt: Date | null;
}): "account:billing.packagePurchaseReversed" | null {
  return payment.revokedAt === null
    ? null
    : "account:billing.packagePurchaseReversed";
}
