import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

// Account deletion needs the durable remote handle even after redirect
// eligibility has expired. Keep this narrow read separate from the checkout
// mutation API so closure can resolve only the currently bound Session.
export async function findBoundProCheckoutAttemptForAccountDeletion({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}): Promise<{
  billingOfferId: string;
  stripeCheckoutSessionId: string;
} | null> {
  const db = prisma ?? await getDb();
  const attempt = await db.proCheckoutAttempt.findUnique({
    where: { userId },
    select: {
      billingOfferId: true,
      stripeCheckoutSessionId: true,
    },
  });
  if (!attempt || attempt.stripeCheckoutSessionId === null) {
    return null;
  }
  return {
    billingOfferId: attempt.billingOfferId,
    stripeCheckoutSessionId: attempt.stripeCheckoutSessionId,
  };
}
