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

export type StripeCustomerOwnershipRecord = {
  stripeId: string;
  userId: string;
  migrationCohort: string | null;
  verifiedAt: Date | null;
  createdAt?: Date;
};

export type StripeCustomerOwnershipProof =
  | "stripe-metadata"
  | "mismatch";

export function getStripeCustomerOwnershipProof({
  customerId,
  metadata,
  ownership,
  userId,
}: {
  customerId: string;
  metadata: StripeOwnershipMetadata | null | undefined;
  ownership: StripeCustomerOwnershipRecord | null | undefined;
  userId: string;
}): StripeCustomerOwnershipProof {
  if (
    !ownership ||
    ownership.stripeId !== customerId ||
    ownership.userId !== userId
  ) {
    return "mismatch";
  }
  if (hasStripeOwnerMetadata(metadata, userId)) {
    return "stripe-metadata";
  }

  return "mismatch";
}
