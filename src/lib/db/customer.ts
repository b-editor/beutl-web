import "server-only";
import { drizzle } from "@/drizzle";
import { createStripe } from "../stripe/config";
import type { Transaction } from "./transaction";
import { customer } from "@/drizzle/schema";
import { eq } from "drizzle-orm";

export async function updateCustomerEmailIfExist({
  userId,
  email,
  transaction,
}: {
  userId: string;
  email: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  const row = await db.select({
    stripeId: customer.stripeId,
  })
    .from(customer)
    .where(eq(customer.userId, userId))
    .limit(1)
    .then(r => r.at(0));
  if (row) {
    const stripe = createStripe();
    await stripe.customers.update(row.stripeId, {
      email: email,
    });
  }
}
