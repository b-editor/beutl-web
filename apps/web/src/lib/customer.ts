import {
  createCustomer,
  deleteCustomerByUserId,
  findCustomerByUserId,
} from "@beutl/db";
import { createStripe } from "@/lib/stripe/config";
import type { PrismaTransaction } from "@beutl/db";

export async function updateCustomerEmailIfExist({
  userId,
  email,
  prisma,
}: {
  userId: string;
  email: string;
  prisma?: PrismaTransaction;
}) {
  const customer = await findCustomerByUserId({ userId, prisma });
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
  const customer = await findCustomerByUserId({ userId, prisma });
  const stripe = createStripe();
  let customerId = customer?.stripeId;
  if (customerId) {
    const c = await stripe.customers.retrieve(customerId);
    if (c?.deleted) {
      await deleteCustomerByUserId({ userId, prisma });
      customerId = undefined;
    }
  }

  if (!customerId) {
    customerId = (await stripe.customers.list({ email: email })).data[0]?.id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: email });
      customerId = customer.id;
      await createCustomer({
        userId: userId,
        stripeId: customerId,
        prisma,
      });
    }
  }
  return customerId;
}
