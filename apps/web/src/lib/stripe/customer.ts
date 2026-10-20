import {
  createVerifiedCustomerMappingIfAbsent,
  beginStripeCustomerProvisioning,
  findAccountDeletionIntentByUserId,
  findCustomerByUserId,
  markStripeCustomerOwnershipVerified,
  replaceCustomerMappingWithVerifiedOwnership,
  recordStripeCustomerProvisioningRemote,
  scheduleStripeCustomerProvisioningCleanup,
  settleStripeCustomerProvisioning,
  updateStripeCustomerProvisioningKey,
} from "@beutl/db";
import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import { isStripeResourceMissingError } from "./errors";
import { createStripe } from "./config";
import {
  getStripeCustomerOwnershipProof,
  isDeletedCustomer,
  hasStripeOwnerMetadata,
  stripeOwnerMetadata,
  type StripeCustomerOwnershipRecord,
} from "./ownership";
import type Stripe from "stripe";

type StripeClient = ReturnType<typeof createStripe>;

type CustomerEmailSyncResult =
  | { status: "not-linked" }
  | { status: "synced"; customerId: string }
  | { status: "customer-deleted"; customerId: string }
  | { status: "owner-mismatch"; customerId: string };

export async function retrieveCustomerIfPresent(
  stripe: StripeClient,
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

async function createRecoverableCustomer({
  stripe,
  params,
  idempotencyKey,
  beforeCreate,
}: {
  stripe: StripeClient;
  params: Stripe.CustomerCreateParams;
  idempotencyKey: string;
  beforeCreate?: (idempotencyKey: string) => Promise<void>;
}): Promise<Stripe.Customer> {
  let nextIdempotencyKey = idempotencyKey;
  for (let recoveryAttempt = 0; recoveryAttempt < 8; recoveryAttempt++) {
    await beforeCreate?.(nextIdempotencyKey);
    const created = await stripe.customers.create(params, {
      idempotencyKey: nextIdempotencyKey,
    });
    const current = await retrieveCustomerIfPresent(stripe, created.id);
    if (current) return current;

    // Stripe can replay a successful create response for a finite period even
    // after compensation deleted that Customer. Chaining the deleted ID into
    // the next key is deterministic, so concurrent retries recover the same
    // live Customer without mapping the cached deleted object.
    nextIdempotencyKey = `beutl:customer-recovery:${created.id}`;
  }

  throw new Error("Stripe repeatedly returned deleted customer creations");
}

async function syncCustomerEmail(
  stripe: StripeClient,
  customerId: string,
  email: string,
): Promise<void> {
  await stripe.customers.update(customerId, {
    email,
  });
}

async function compensateUnmappedCustomer({
  stripe,
  customer,
  userId,
}: {
  stripe: StripeClient;
  customer: Stripe.Customer;
  userId: string;
}): Promise<void> {
  try {
    const mapping = await findCustomerByUserId({ userId });
    if (
      mapping?.stripeId === customer.id ||
      !hasStripeOwnerMetadata(customer.metadata, userId)
    ) {
      return;
    }
    await stripe.customers.del(
      customer.id,
      {},
      {
        idempotencyKey: `beutl:unmapped-customer-cleanup:${customer.id}`,
      },
    );
  } catch (cleanupError) {
    // Preserve the mapping failure as the primary error. The customer keeps
    // owner metadata, so operators can identify it if Stripe cleanup is down.
    console.error("Could not remove an unmapped Stripe customer", {
      cleanupError,
      stripeCustomerId: customer.id,
      userId,
    });
  }
}

// List subscriptions that still bill a Customer whose owner cannot be verified.
async function listActiveSubscriptionsOnCustomer(
  stripe: StripeClient,
  customerId: string,
): Promise<string[]> {
  const billing = new Set([
    "active",
    "trialing",
    "past_due",
    "unpaid",
    "incomplete",
    "paused",
  ]);
  let startingAfter: string | undefined;
  const left: string[] = [];
  for (;;) {
    let subscriptions;
    try {
      subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
    } catch (error) {
      if (isStripeResourceMissingError(error)) break;
      throw error;
    }
    for (const subscription of subscriptions.data) {
      if (billing.has(subscription.status)) left.push(subscription.id);
    }
    if (!subscriptions.has_more) break;
    const last = subscriptions.data.at(-1);
    if (!last) break;
    startingAfter = last.id;
  }
  return left;
}

async function expireOwnedOpenCheckoutSessions({
  stripe,
  customerId,
  userId,
}: {
  stripe: StripeClient;
  customerId: string;
  userId: string;
}): Promise<void> {
  // Scan every page before mutating Stripe. If a later page contains an
  // unowned legacy Session, no earlier Session may have been expired while we
  // were still deciding whether replacement was safe.
  const sessionsToExpire: Stripe.Checkout.Session[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const sessions = await stripe.checkout.sessions.list({
      customer: customerId,
      status: "open",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const session of sessions.data) {
      if (!hasStripeOwnerMetadata(session.metadata, userId)) {
        // An unowned legacy Session is still payable. Moving the local mapping
        // would strand that payment under a Customer the user can no longer
        // reach, so refuse migration until an operator resolves it.
        throw new Error(
          `Cannot replace legacy Stripe customer ${customerId} while open Checkout Session ${session.id} has no verified owner`,
        );
      }
      sessionsToExpire.push(session);
    }
    if (!sessions.has_more) break;
    const lastSession = sessions.data.at(-1);
    if (!lastSession) {
      throw new Error("Stripe returned an empty Checkout page with has_more");
    }
    startingAfter = lastSession.id;
  }
  for (const session of sessionsToExpire) {
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch (error) {
      // The session may have completed between list and expire. Its success
      // replay performs the current-customer check and compensates it.
      if (!isStripeResourceMissingError(error)) throw error;
    }
  }
}

export async function verifyCustomerOwnership({
  customer,
  ownership,
  userId,
}: {
  customer: Stripe.Customer;
  ownership: StripeCustomerOwnershipRecord | null | undefined;
  userId: string;
}) {
  const proof = getStripeCustomerOwnershipProof({
    customerId: customer.id,
    metadata: customer.metadata,
    ownership,
    userId,
  });
  if (proof === "stripe-metadata" && ownership?.verifiedAt === null) {
    await markStripeCustomerOwnershipVerified({
      userId,
      stripeId: customer.id,
    });
  }
  return proof;
}

export async function updateCustomerEmailIfExist({
  userId,
  email,
}: {
  userId: string;
  email: string;
}): Promise<CustomerEmailSyncResult> {
  const mapping = await findCustomerByUserId({ userId });
  if (!mapping) {
    return { status: "not-linked" };
  }

  const stripe = createStripe();
  const customer = await retrieveCustomerIfPresent(stripe, mapping.stripeId);
  if (!customer) {
    return {
      status: "customer-deleted",
      customerId: mapping.stripeId,
    };
  }
  const proof = await verifyCustomerOwnership({
    customer,
    ownership: mapping.ownership,
    userId,
  });
  if (proof === "mismatch") {
    return { status: "owner-mismatch", customerId: customer.id };
  }
  await syncCustomerEmail(stripe, customer.id, email);
  return { status: "synced", customerId: customer.id };
}

async function createOwnedCustomer({
  stripe,
  email,
  userId,
  replacesCustomerId,
}: {
  stripe: StripeClient;
  email: string;
  userId: string;
  replacesCustomerId?: string;
}): Promise<string> {
  const customerParams: Stripe.CustomerCreateParams = {
    metadata: stripeOwnerMetadata(userId),
  };
  const customerIdempotencyKey = replacesCustomerId
    ? `beutl:customer:${userId}:replace:${replacesCustomerId}`
    : `beutl:customer:${userId}`;
  const provisioningLeaseToken = crypto.randomUUID();
  const provisioningLeaseExpiresAt = new Date(Date.now() + 10 * 60_000);
  const provisioning = await beginStripeCustomerProvisioning({
    userId,
    operationKey: `beutl:customer-provisioning:${userId}:${replacesCustomerId ?? "initial"}`,
    stripeIdempotencyKey: customerIdempotencyKey,
    paramsJson: JSON.stringify(customerParams),
    leaseToken: provisioningLeaseToken,
    leaseExpiresAt: provisioningLeaseExpiresAt,
  });
  const customer = await createRecoverableCustomer({
    stripe,
    params: customerParams,
    idempotencyKey: customerIdempotencyKey,
    beforeCreate: async (key) => {
      const updated = await updateStripeCustomerProvisioningKey({ id: provisioning.id, stripeIdempotencyKey: key, leaseToken: provisioningLeaseToken });
      if (updated.count !== 1) {
        throw new Error("Stripe customer provisioning lease changed before remote create");
      }
    },
  });
  if (!hasStripeOwnerMetadata(customer.metadata, userId)) {
    throw new Error("Stripe did not persist customer ownership metadata");
  }
  let mappingCommitted = false;
  try {
    await recordStripeCustomerProvisioningRemote({
      id: provisioning.id,
      stripeCustomerId: customer.id,
      leaseToken: provisioningLeaseToken,
    });
    if (replacesCustomerId) {
      await expireOwnedOpenCheckoutSessions({
        stripe,
        customerId: replacesCustomerId,
        userId,
      });
      // Moving the mapping would hide billing on the old Customer from the
      // user's portal and all later deletion flows. Ownership cannot be proven
      // without metadata, so neither cancel the subscription nor migrate the
      // mapping; leave the account blocked for an operator to resolve.
      const left = await listActiveSubscriptionsOnCustomer(
        stripe,
        replacesCustomerId,
      );
      if (left.length > 0) {
        await addAuditLog({
          userId,
          action: auditLogActions.account.legacyCustomerLeftBilling,
          details:
            `Stripe customer ${replacesCustomerId} still billing `
            + `(${left.join(", ")}) — replacement blocked`,
        });
        throw new Error(
          `Cannot replace a legacy Stripe customer that still has `
          + `active subscriptions: ${replacesCustomerId}`,
        );
      }
      await replaceCustomerMappingWithVerifiedOwnership({
        userId,
        expectedStripeId: replacesCustomerId,
        stripeId: customer.id,
      });
    } else {
      await createVerifiedCustomerMappingIfAbsent({
        userId,
        stripeId: customer.id,
      });
    }
    const mapping = await findCustomerByUserId({ userId });
    if (!mapping || mapping.stripeId !== customer.id) {
      throw new Error("Stripe customer mapping changed concurrently");
    }
    mappingCommitted = true;

    // Persist the ownership mapping before secondary Stripe attributes. If this
    // update fails, the next billing operation retries it using the saved mapping.
    await syncCustomerEmail(stripe, customer.id, email);
    await settleStripeCustomerProvisioning({ id: provisioning.id, leaseToken: provisioningLeaseToken });
    return customer.id;
  } catch (error) {
    if (mappingCommitted) {
      throw error;
    }
    await scheduleStripeCustomerProvisioningCleanup({
      id: provisioning.id,
      leaseToken: provisioningLeaseToken,
      lastError: error instanceof Error ? error.message : String(error),
    }).catch((cleanupError) => {
      console.error("Could not persist Stripe customer cleanup", cleanupError);
    });
    await compensateUnmappedCustomer({ stripe, customer, userId });
    throw error;
  }
}

export async function createOrRetrieveOwnedCustomerId({
  email,
  userId,
}: {
  email: string;
  userId: string;
}): Promise<string> {
  if (await findAccountDeletionIntentByUserId({ userId })) {
    throw new Error("Account deletion is already authorized");
  }
  const mapping = await findCustomerByUserId({ userId });
  const stripe = createStripe();
  if (mapping) {
    const customer = await retrieveCustomerIfPresent(stripe, mapping.stripeId);
    if (customer) {
      const proof = await verifyCustomerOwnership({
        customer,
        ownership: mapping.ownership,
        userId,
      });
      if (proof !== "mismatch") {
        await syncCustomerEmail(stripe, customer.id, email);
        return customer.id;
      }
      throw new Error(
        `Cannot replace legacy Stripe customer ${mapping.stripeId} without verified ownership`,
      );
    }
    // A deleted Customer has no remote payable state left to strand, so its
    // local mapping may be replaced with a newly metadata-owned Customer.
    return await createOwnedCustomer({
      stripe,
      email,
      userId,
      replacesCustomerId: mapping.stripeId,
    });
  }

  return await createOwnedCustomer({ stripe, email, userId });
}

