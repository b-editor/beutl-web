// Repairs subscription rows that Stripe already terminated.
//
// A refund issued together with a cancellation can leave the local row on its
// last non-terminal status when the matching subscription webhook is missed. The
// row then reports an active plan until its stored period elapses, which keeps AI
// features enabled for someone who no longer has a subscription.
//
// Runs read-only by default; pass --apply to write.
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";

const TERMINAL_STATUSES = new Set(["canceled", "incomplete_expired"]);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function getSubscriptionPeriod(subscription) {
  const item = subscription.items?.data?.[0];
  const start = item?.current_period_start ?? subscription.current_period_start;
  const end = item?.current_period_end ?? subscription.current_period_end;
  return {
    currentPeriodStart: start ? new Date(start * 1000) : null,
    currentPeriodEnd: end ? new Date(end * 1000) : null,
  };
}

export function getScheduledCancellationTime(subscription) {
  return typeof subscription.cancel_at === "number" &&
    subscription.cancel_at > 0
    ? new Date(subscription.cancel_at * 1000)
    : null;
}

// Only rows that still claim a usable plan are worth repairing.
export function needsRepair(stored, subscription) {
  if (isTerminalStatus(stored.status)) {
    return false;
  }
  return isTerminalStatus(subscription.status);
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
  let repaired = 0;

  try {
    for (;;) {
      const subscriptions = await prisma.subscription.findMany({
        where: {
          status: { notIn: [...TERMINAL_STATUSES] },
          ...(cursor ? { userId: { gt: cursor } } : {}),
        },
        orderBy: { userId: "asc" },
        take: 100,
      });
      if (subscriptions.length === 0) {
        break;
      }
      cursor = subscriptions[subscriptions.length - 1].userId;

      for (const stored of subscriptions) {
        inspected++;
        let subscription;
        try {
          subscription = await stripe.subscriptions.retrieve(
            stored.stripeSubscriptionId,
          );
        } catch (error) {
          if (error?.code === "resource_missing") {
            // Stripe has definitively removed this subscription. Reconcile it
            // to the same terminal state the webhook and account-page sync use.
            console.log(
              `${apply ? "REPAIR" : "WOULD_REPAIR"} ${stored.userId}: ${stored.status} -> canceled (${stored.stripeSubscriptionId}, missing from Stripe)`,
            );
            if (apply) {
              await prisma.subscription.updateMany({
                where: {
                  userId: stored.userId,
                  stripeSubscriptionId: stored.stripeSubscriptionId,
                  status: { notIn: [...TERMINAL_STATUSES] },
                },
                data: {
                  status: "canceled",
                  cancelAtPeriodEnd: false,
                  cancelAt: null,
                },
              });
              await prisma.proCheckoutAttempt.deleteMany({
                where: { userId: stored.userId },
              });
            }
            repaired++;
            continue;
          }
          throw error;
        }

        if (!needsRepair(stored, subscription)) {
          continue;
        }

        console.log(
          `${apply ? "REPAIR" : "WOULD_REPAIR"} ${stored.userId}: ${stored.status} -> ${subscription.status} (${subscription.id})`,
        );
        if (!apply) {
          repaired++;
          continue;
        }

        const period = getSubscriptionPeriod(subscription);
        await prisma.subscription.updateMany({
          where: {
            userId: stored.userId,
            stripeSubscriptionId: stored.stripeSubscriptionId,
            status: { notIn: [...TERMINAL_STATUSES] },
          },
          data: {
            status: subscription.status,
            currentPeriodStart: period.currentPeriodStart,
            currentPeriodEnd: period.currentPeriodEnd,
            cancelAtPeriodEnd:
              subscription.cancel_at_period_end === true ||
              getScheduledCancellationTime(subscription) !== null,
            cancelAt: getScheduledCancellationTime(subscription),
          },
        });
        await prisma.proCheckoutAttempt.deleteMany({
          where: { userId: stored.userId },
        });
        repaired++;
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(JSON.stringify({ apply, inspected, repaired }, null, 2));
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
if (entryPoint === import.meta.url) {
  await main();
}
