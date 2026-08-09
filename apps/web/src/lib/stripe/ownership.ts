import type Stripe from "stripe";

export const STRIPE_APPLICATION_METADATA_VALUE = "beutl-web";

export type StripeOwnershipMetadata = Record<string, string | undefined>;

export function stripeOwnerMetadata(userId: string): Record<string, string> {
  return {
    beutlApplication: STRIPE_APPLICATION_METADATA_VALUE,
    beutlUserId: userId,
  };
}

export function hasStripeOwnerMetadata(
  metadata: StripeOwnershipMetadata | null | undefined,
  userId: string,
): boolean {
  return (
    metadata?.beutlApplication === STRIPE_APPLICATION_METADATA_VALUE &&
    metadata.beutlUserId === userId
  );
}

export function hasConflictingStripeOwnerMetadata(
  metadata: StripeOwnershipMetadata | null | undefined,
  userId: string,
): boolean {
  const hasAnyOwnershipMetadata =
    metadata?.beutlApplication !== undefined ||
    metadata?.beutlUserId !== undefined;
  return hasAnyOwnershipMetadata && !hasStripeOwnerMetadata(metadata, userId);
}

export function getExpandableId(
  value: string | { id: string } | null | undefined,
): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

export function isDeletedCustomer(
  customer: Stripe.Customer | Stripe.DeletedCustomer,
): customer is Stripe.DeletedCustomer {
  return "deleted" in customer && customer.deleted === true;
}
