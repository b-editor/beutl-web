import "server-only";
import { drizzle } from "@/drizzle";
import { createStripe } from "./stripe/config";
import { customer } from "@/drizzle/schema";
import { eq } from "drizzle-orm";

export async function createOrRetrieveCustomerId(
  email: string,
  userId: string,
) {
  const db = await drizzle();
  const customerRow = await db.select().from(customer)
    .where(eq(customer.userId, userId))
    .limit(1)
    .then((rows) => rows.at(0));
  const stripe = createStripe();
  let customerId = customerRow?.stripeId;
  if (customerId) {
    const c = await stripe.customers.retrieve(customerId);
    if (c?.deleted) {
      await db.delete(customer)
        .where(eq(customer.userId, userId));
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
