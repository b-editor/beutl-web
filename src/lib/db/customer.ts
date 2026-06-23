import "server-only";
import { getDbAsync } from "@/prisma";
import { createStripe } from "../stripe/config";
import type { PrismaTransaction } from "./transaction";

export async function updateCustomerEmailIfExist({
  userId,
  email,
  prisma,
}: {
  userId: string;
  email: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
  const customer = await db.customer.findFirst({
    where: {
      userId: userId,
    },
    select: {
      stripeId: true,
    },
  });
  if (customer) {
    const stripe = createStripe();
    await stripe.customers.update(customer.stripeId, {
      email: email,
    });
  }
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
  const db = prisma ?? await getDbAsync();
  const customer = await db.customer.findFirst({
    where: {
      userId: userId,
    },
  });
  const stripe = createStripe();
  let customerId = customer?.stripeId;
  if (customerId) {
    const c = await stripe.customers.retrieve(customerId);
    if (c?.deleted) {
      await db.customer.deleteMany({
        where: {
          userId: userId,
        },
      });
      customerId = undefined;
    }
  }

  if (!customerId) {
    customerId = (await stripe.customers.list({ email: email })).data[0]?.id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: email });
      customerId = customer.id;
      await db.customer.create({
        data: {
          userId: userId,
          stripeId: customerId,
        },
      });
    }
  }
  return customerId;
}
