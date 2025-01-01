import "server-only";
import { prisma as sharedPrisma } from "@/prisma";
import { createStripe } from "../stripe/config";
import type { PrismaTransaction } from "./transaction";

export async function updateCustomerEmailIfExist({
  userId, email, prisma
}: {
  userId: string, email: string, prisma?: PrismaTransaction,
}) {
  const p = prisma || sharedPrisma;
  const customer = await p.customer.findFirst({
    where: {
      userId: userId
    },
    select: {
      stripeId: true,
    }
  });
  if (customer) {
    const stripe = createStripe();
    await stripe.customers.update(customer.stripeId, {
      email: email
    });
  }
}