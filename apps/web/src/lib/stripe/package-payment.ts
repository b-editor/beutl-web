import {
  findCustomerOwnersByStripeId,
  getDb,
  type PackagePaymentReference,
} from "@beutl/db";
import {
  isStripeChargeAlreadyRefundedError,
  isStripeResourceMissingError,
} from "./errors";
import {
  getExpandableId,
  hasStripeOwnerMetadata,
  isDeletedCustomer,
} from "./ownership";
import { PACKAGE_PURCHASE_METADATA_VALUE } from "./store-checkout";
import type Stripe from "stripe";

type PackagePaymentStripeClient = {
  customers: Pick<Stripe.CustomersResource, "retrieve">;
  refunds: Pick<Stripe.RefundsResource, "create">;
};

export type PackagePaymentOwnerResolution =
  | { status: "owned"; reference: PackagePaymentReference }
  | { status: "invalid"; reason: string }
  | { status: "unrecognized" };

export type PackagePaymentResolution =
  | { status: "fulfill"; reference: PackagePaymentReference }
  | { status: "refund"; reason: string }
  | { status: "unrecognized" };

async function retrieveCustomer(
  stripe: PackagePaymentStripeClient,
  customerId: string,
): Promise<Stripe.Customer | null> {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return isDeletedCustomer(customer) ? null : customer;
  } catch (error) {
    if (isStripeResourceMissingError(error)) {
      return null;
    }
    throw error;
  }
}

export async function resolvePackagePaymentOwner({
  paymentIntent,
  stripe,
}: {
  paymentIntent: Stripe.PaymentIntent;
  stripe: PackagePaymentStripeClient;
}): Promise<PackagePaymentOwnerResolution> {
  const packageId = paymentIntent.metadata.packageId?.trim();
  const purchaseKind = paymentIntent.metadata.beutlPurchaseKind;
  if (
    purchaseKind !== undefined &&
    purchaseKind !== PACKAGE_PURCHASE_METADATA_VALUE
  ) {
    return { status: "unrecognized" };
  }
  if (!packageId) {
    return purchaseKind === PACKAGE_PURCHASE_METADATA_VALUE
      ? { status: "invalid", reason: "missing package id" }
      : { status: "unrecognized" };
  }
  if (purchaseKind !== PACKAGE_PURCHASE_METADATA_VALUE) {
    return { status: "invalid", reason: "missing package ownership binding" };
  }

  const userId = paymentIntent.metadata.beutlUserId?.trim();
  const customerId = getExpandableId(paymentIntent.customer);
  if (!userId || !customerId) {
    return { status: "invalid", reason: "missing payment owner" };
  }
  if (!hasStripeOwnerMetadata(paymentIntent.metadata, userId)) {
    return { status: "invalid", reason: "payment owner metadata mismatch" };
  }

  const owners = await findCustomerOwnersByStripeId({ stripeId: customerId });
  if (owners.length !== 1 || owners[0]?.userId !== userId) {
    return { status: "invalid", reason: "customer mapping mismatch" };
  }

  const customer = await retrieveCustomer(stripe, customerId);
  if (!customer) {
    return { status: "invalid", reason: "Stripe customer is closed" };
  }
  if (!hasStripeOwnerMetadata(customer.metadata, userId)) {
    return { status: "invalid", reason: "Stripe customer owner mismatch" };
  }

  return {
    status: "owned",
    reference: {
      paymentId: paymentIntent.id,
      userId,
      packageId,
    },
  };
}

type PackagePriceValidation =
  | { valid: true }
  | { valid: false; reason: string };

async function validateCurrentPackagePrice(
  paymentIntent: Stripe.PaymentIntent,
  packageId: string,
): Promise<PackagePriceValidation> {
  if (
    paymentIntent.status !== "succeeded" ||
    !Number.isSafeInteger(paymentIntent.amount) ||
    paymentIntent.amount <= 0 ||
    paymentIntent.amount_received !== paymentIntent.amount ||
    paymentIntent.currency.trim().length === 0
  ) {
    return {
      valid: false,
      reason: "payment status, amount, or currency is invalid",
    };
  }

  const db = await getDb();
  const pkg = await db.package.findFirst({
    where: {
      id: packageId,
      published: true,
      packagePricing: {
        some: {
          price: paymentIntent.amount,
          currency: {
            equals: paymentIntent.currency,
            mode: "insensitive",
          },
        },
      },
    },
    select: { id: true },
  });
  return pkg
    ? { valid: true }
    : { valid: false, reason: "package is unpublished or price changed" };
}

export async function resolvePackagePayment({
  paymentIntent,
  stripe,
}: {
  paymentIntent: Stripe.PaymentIntent;
  stripe: PackagePaymentStripeClient;
}): Promise<PackagePaymentResolution> {
  const owner = await resolvePackagePaymentOwner({ paymentIntent, stripe });
  if (owner.status === "unrecognized") {
    return owner;
  }
  if (owner.status === "invalid") {
    return { status: "refund", reason: owner.reason };
  }
  const price = await validateCurrentPackagePrice(
    paymentIntent,
    owner.reference.packageId,
  );
  if (!price.valid) {
    return {
      status: "refund",
      reason: price.reason,
    };
  }
  return { status: "fulfill", reference: owner.reference };
}

export async function refundPackagePayment({
  paymentIntentId,
  reason,
  stripe,
}: {
  paymentIntentId: string;
  reason: string;
  stripe: PackagePaymentStripeClient;
}): Promise<void> {
  try {
    await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        reason: "requested_by_customer",
        metadata: {
          beutlDisposition: "package-payment-validation-failed",
          beutlDispositionReason: reason.slice(0, 500),
        },
      },
      {
        idempotencyKey: `beutl:package-payment:${paymentIntentId}:refund`,
      },
    );
  } catch (error) {
    if (!isStripeChargeAlreadyRefundedError(error)) {
      throw error;
    }
  }
}
