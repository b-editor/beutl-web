import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

// Account deletion needs the durable remote handle even after redirect
// eligibility has expired. Keep this narrow read separate from the checkout
// mutation API so closure can resolve only the currently bound Sessions, one
// per plan.
export async function findBoundSubscriptionCheckoutAttemptsForAccountDeletion({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}): Promise<Array<{
  planId: string;
  tier: string | null;
  billingOfferId: string;
  stripeCheckoutSessionId: string;
}>> {
  const db = prisma ?? await getDb();
  const attempts = await db.subscriptionCheckoutAttempt.findMany({
    where: { userId, stripeCheckoutSessionId: { not: null } },
    select: {
      planId: true,
      tier: true,
      billingOfferId: true,
      stripeCheckoutSessionId: true,
    },
  });
  return attempts.flatMap((attempt) =>
    attempt.stripeCheckoutSessionId === null
      ? []
      : [{
          planId: attempt.planId,
          tier: attempt.tier,
          billingOfferId: attempt.billingOfferId,
          stripeCheckoutSessionId: attempt.stripeCheckoutSessionId,
        }],
  );
}
