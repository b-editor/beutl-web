import "server-only";
import { getDbAsync } from "@/db";
import { customer } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createStripe } from "../stripe/config";
import type { DbTransaction } from "./transaction";

export async function updateCustomerEmailIfExist({
  userId,
  email,
  tx,
}: {
  userId: string;
  email: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .select({ stripeId: customer.stripeId })
    .from(customer)
    .where(eq(customer.userId, userId))
    .limit(1);
  if (result[0]) {
    const stripe = createStripe();
    await stripe.customers.update(result[0].stripeId, {
      email: email,
    });
  }
}
