import { getDbAsync } from "@/db";
import { customer } from "@/db/schema";
import { eq } from "drizzle-orm";
import "server-only";
import { createStripe } from "./stripe/config";

export async function createOrRetrieveCustomerId(
  email: string,
  userId: string,
) {
  const db = await getDbAsync();
  const result = await db.query.customer.findFirst({
    where: eq(customer.userId, userId),
  });
  const stripe = createStripe();
  let customerId = result?.stripeId;
  if (customerId) {
    const c = await stripe.customers.retrieve(customerId);
    if (c?.deleted) {
      await db.delete(customer).where(eq(customer.userId, userId));
      customerId = undefined;
    }
  }

  if (!customerId) {
    customerId = (await stripe.customers.list({ email: email })).data[0]?.id;
    if (!customerId) {
      const stripeCustomer = await stripe.customers.create({ email: email });
      customerId = stripeCustomer.id;
      await db.insert(customer).values({
        userId: userId,
        stripeId: customerId,
      });
    }
  }
  return customerId;
}
