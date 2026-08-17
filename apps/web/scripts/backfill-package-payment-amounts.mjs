// Fills UserPaymentHistory.stripePaymentAmount / stripeCurrency for rows written
// before 20260817000000_store_package_payment_amount. Run this after applying the
// migration and before deploying the billing page, otherwise every historical
// payment renders without an amount.
//
// Usage: pnpm --filter @beutl/web backfill:package-payment-amounts [--apply]
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";

const PAGE_SIZE = 100;
const CONCURRENCY = 5;

// The authorized amount, not amount_received. recordPackagePaymentSucceeded
// matches PaymentIntent.amount against PackagePricing.price, so using anything
// else here would make historical rows disagree with newly written ones.
export function selectPackagePaymentAmount(paymentIntent) {
  const amount = paymentIntent?.amount;
  const currency = paymentIntent?.currency;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return null;
  }
  if (typeof currency !== "string" || currency.trim().length === 0) {
    return null;
  }
  return { amount, currency: currency.toLowerCase() };
}

export function isStripeResourceMissing(error) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "resource_missing",
  );
}

async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await task(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
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
  let filled = 0;
  let missing = 0;
  let failed = 0;

  try {
    for (;;) {
      const histories = await prisma.userPaymentHistory.findMany({
        where: {
          stripePaymentAmount: null,
          ...(cursor ? { paymentId: { gt: cursor } } : {}),
        },
        orderBy: { paymentId: "asc" },
        take: PAGE_SIZE,
        select: { paymentId: true },
      });
      if (histories.length === 0) {
        break;
      }
      cursor = histories[histories.length - 1].paymentId;
      inspected += histories.length;

      const resolved = await mapWithConcurrency(
        histories,
        CONCURRENCY,
        async ({ paymentId }) => {
          // One unreadable PaymentIntent must not abort the whole backfill.
          try {
            const paymentIntent = await stripe.paymentIntents.retrieve(
              paymentId,
            );
            return { paymentId, billing: selectPackagePaymentAmount(paymentIntent) };
          } catch (error) {
            if (isStripeResourceMissing(error)) {
              console.warn(`SKIP ${paymentId}: no such PaymentIntent`);
              return { paymentId, billing: null, missing: true };
            }
            console.error(`FAIL ${paymentId}:`, error);
            return { paymentId, billing: null, failed: true };
          }
        },
      );

      for (const entry of resolved) {
        if (entry.missing) missing++;
        if (entry.failed) failed++;
        if (!entry.billing) continue;
        console.log(
          `${apply ? "FILL" : "WOULD_FILL"} ${entry.paymentId}: ${entry.billing.amount} ${entry.billing.currency}`,
        );
        if (!apply) continue;
        // updateMany with the null guard keeps a concurrent webhook write from
        // being overwritten by this backfill.
        const result = await prisma.userPaymentHistory.updateMany({
          where: { paymentId: entry.paymentId, stripePaymentAmount: null },
          data: {
            stripePaymentAmount: entry.billing.amount,
            stripeCurrency: entry.billing.currency,
          },
        });
        filled += result.count;
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    JSON.stringify({ apply, inspected, filled, missing, failed }, null, 2),
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
if (entryPoint === import.meta.url) {
  await main();
}
