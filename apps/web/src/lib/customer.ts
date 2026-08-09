import {
  findCustomerByUserId,
  findCustomerOwnersByStripeId,
  type PrismaTransaction,
  upsertCustomerMapping,
} from "@beutl/db";
import { createStripe } from "@/lib/stripe/config";
import { isStripeResourceMissingError } from "@/lib/stripe/errors";
import {
  hasConflictingStripeOwnerMetadata,
  hasStripeOwnerMetadata,
  isDeletedCustomer,
  stripeOwnerMetadata,
} from "@/lib/stripe/ownership";
import { createHash } from "@beutl/core";
import type Stripe from "stripe";

type StripeClient = ReturnType<typeof createStripe>;

async function retrieveCustomerIfPresent(
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
}): Promise<Stripe.Customer> {
  const emailDigest = (await createHash(email)).slice(0, 16);
  return await stripe.customers.create(
    {
      email,
      metadata: stripeOwnerMetadata(userId),
    },
    {
      idempotencyKey: replacesCustomerId
        ? `beutl:customer:${userId}:replace:${replacesCustomerId}:${emailDigest}`
        : `beutl:customer:${userId}:${emailDigest}`,
    },
  );
}

export async function createOrRetrieveCustomerId({
  email,
  userId,
  prisma,
}: {
  email: string;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const mapping = await findCustomerByUserId({ userId, prisma });
  const stripe = createStripe();

  if (mapping) {
    const [customer, owners] = await Promise.all([
      retrieveCustomerIfPresent(stripe, mapping.stripeId),
      findCustomerOwnersByStripeId({
        stripeId: mapping.stripeId,
        prisma,
      }),
    ]);
    const mappingIsUnique =
      owners.length === 1 && owners[0]?.userId === userId;
    if (
      customer &&
      mappingIsUnique &&
      !hasConflictingStripeOwnerMetadata(customer.metadata, userId)
    ) {
      if (!hasStripeOwnerMetadata(customer.metadata, userId)) {
        await stripe.customers.update(customer.id, {
          email,
          metadata: stripeOwnerMetadata(userId),
        });
      } else if (customer.email !== email) {
        await stripe.customers.update(customer.id, { email });
      }
      return customer.id;
    }
  }

  const customer = await createOwnedCustomer({
    stripe,
    email,
    userId,
    replacesCustomerId: mapping?.stripeId,
  });
  await upsertCustomerMapping({
    userId,
    stripeId: customer.id,
    prisma,
  });
  return customer.id;
}

export async function synchronizeMappedStripeCustomer({
  userId,
  email,
  prisma,
}: {
  userId: string;
  email: string;
  prisma?: PrismaTransaction;
}) {
  const mapping = await findCustomerByUserId({ userId, prisma });
  if (mapping) {
    await createOrRetrieveCustomerId({ userId, email, prisma });
  }
}
