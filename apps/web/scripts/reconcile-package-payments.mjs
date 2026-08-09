import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";

const EVENT_RANK = {
  disputeRestored: 20,
  disputeRevoked: 30,
  refundSucceeded: 40,
};
const REVOKED_DISPUTE_STATUSES = new Set([
  "needs_response",
  "under_review",
  "lost",
]);

export function classifyHistoricalPackagePayment({
  paymentIntent,
  refunds,
  disputes,
}) {
  const refund = refunds
    .filter((item) => item.status === "succeeded")
    .sort((left, right) => right.created - left.created)[0];
  if (refund) {
    return {
      rank: EVENT_RANK.refundSucceeded,
      reason: `historical refund succeeded: ${refund.id}`,
      sourceId: refund.id,
      sourceKind: "refund",
    };
  }

  const dispute = disputes
    .filter((item) => REVOKED_DISPUTE_STATUSES.has(item.status))
    .sort((left, right) => {
      const leftRank = left.status === "lost" ? 1 : 0;
      const rightRank = right.status === "lost" ? 1 : 0;
      return rightRank - leftRank || right.created - left.created;
    })[0];
  if (dispute) {
    return {
      rank: EVENT_RANK.disputeRevoked,
      reason: `historical dispute ${dispute.status}: ${dispute.id}`,
      sourceId: dispute.id,
      sourceKind: "dispute",
    };
  }

  if (paymentIntent.status !== "succeeded") {
    return {
      rank: EVENT_RANK.refundSucceeded,
      reason: `historical PaymentIntent status: ${paymentIntent.status}`,
      sourceId: paymentIntent.id,
      sourceKind: "payment-intent",
    };
  }
  return null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const connectionString = process.env.DATABASE_URL;
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!connectionString || !stripeSecret) {
    throw new Error("DATABASE_URL and STRIPE_SECRET_KEY are required");
  }

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });
  const stripe = new Stripe(stripeSecret, {
    httpClient: Stripe.createFetchHttpClient(),
  });
  let cursor = "";
  let inspected = 0;
  let candidates = 0;
  let revoked = 0;

  try {
    for (;;) {
      const histories = await prisma.userPaymentHistory.findMany({
        where: {
          revokedAt: null,
          ...(cursor ? { paymentId: { gt: cursor } } : {}),
        },
        orderBy: { paymentId: "asc" },
        take: 100,
        select: {
          paymentId: true,
          packageId: true,
          userId: true,
        },
      });
      if (histories.length === 0) {
        break;
      }

      for (const history of histories) {
        cursor = history.paymentId;
        inspected++;
        const [paymentIntent, refunds, disputes] = await Promise.all([
          stripe.paymentIntents.retrieve(history.paymentId),
          stripe.refunds.list({
            payment_intent: history.paymentId,
            limit: 100,
          }).autoPagingToArray({ limit: 1_000 }),
          stripe.disputes.list({
            payment_intent: history.paymentId,
            limit: 100,
          }).autoPagingToArray({ limit: 1_000 }),
        ]);
        let candidate = classifyHistoricalPackagePayment({
          paymentIntent,
          refunds,
          disputes,
        });
        if (!candidate) {
          continue;
        }
        candidates++;
        console.log(
          `${apply ? "REVOKE" : "WOULD_REVOKE"} ${history.paymentId}: ${candidate.reason}`,
        );
        if (!apply) {
          continue;
        }

        if (candidate.sourceKind === "dispute") {
          const currentDispute = await stripe.disputes.retrieve(
            candidate.sourceId,
          );
          candidate = classifyHistoricalPackagePayment({
            paymentIntent,
            refunds,
            disputes: [currentDispute],
          });
          if (!candidate) {
            continue;
          }
        }

        const observedAt = new Date();
        const changed = await prisma.$transaction(async (tx) => {
          const current = await tx.userPaymentHistory.findUnique({
            where: { paymentId: history.paymentId },
            select: { revokedAt: true },
          });
          if (!current || current.revokedAt) {
            return false;
          }
          await tx.userPaymentHistory.update({
            where: { paymentId: history.paymentId },
            data: {
              revokedAt: observedAt,
              revocationReason: candidate.reason,
              stripeStateEventId: `reconcile:${candidate.sourceId}`,
              stripeStateEventCreatedAt: observedAt,
              stripeStateEventRank: candidate.rank,
            },
          });
          const activePayments = await tx.userPaymentHistory.count({
            where: {
              userId: history.userId,
              packageId: history.packageId,
              revokedAt: null,
            },
          });
          if (activePayments === 0) {
            await tx.userPackage.deleteMany({
              where: {
                userId: history.userId,
                packageId: history.packageId,
                paymentManaged: true,
              },
            });
          }
          return true;
        });
        if (changed) {
          revoked++;
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    JSON.stringify({ apply, inspected, candidates, revoked }, null, 2),
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
if (entryPoint === import.meta.url) {
  await main();
}
