import { prisma } from "@/prisma";
import "server-only";
import { createStripe } from "./stripe/config";

export async function createOrRetrieveCustomerId(
  email: string,
  userId: string,
) {
  const db = await prisma();
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
      db.customer.deleteMany({
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
