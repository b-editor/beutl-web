import { prisma } from "@/prisma";
import "server-only";
import { stripe } from "./stripe/config";

export async function createOrRetrieveCustomerId(email: string, userId: string) {
  const customer = await prisma.customer.findFirst({
    where: {
      userId: userId
    }
  });
  let customerId = customer?.stripeId;
  if (customerId) {
    const c = await stripe.customers.retrieve(customerId);
    if (c?.deleted) {
      prisma.customer.deleteMany({
        where: {
          userId: userId
        }
      });
      customerId = undefined;
    }
  }

  if (!customerId) {
    customerId = (await stripe.customers.list({ email: email })).data[0]?.id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: email });
      customerId = customer.id;
      await prisma.customer.create({
        data: {
          userId: userId,
          stripeId: customerId
        }
      });
    }
  }
  return customerId;
}