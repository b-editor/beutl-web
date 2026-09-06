import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  addPurchasedCredits,
  getCreditAccount,
  reconcilePurchasedCreditReversal,
  setDbProvider,
  upsertSubscription,
} from "@beutl/db";
import { createReservedAiJob } from "@beutl/api";

const connectionString = process.env.TEST_DATABASE_URL;
const describeWithCockroach = connectionString ? describe : describe.skip;
const USER_ID = "cockroach-concurrency-user";

describeWithCockroach("AI ledger on CockroachDB", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    const adapter = new PrismaPg({ connectionString: connectionString! });
    prisma = new PrismaClient({ adapter });
    setDbProvider(async () => prisma);
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'DELETE FROM "User" WHERE "id" = $1',
      USER_ID,
    );
    await prisma.$executeRawUnsafe(
      'INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)',
      USER_ID,
      `${USER_ID}@example.com`,
    );
    const billingOffer = await prisma.billingOffer.upsert({
      where: { stripePriceId: "price_cockroach_test_pro" },
      create: {
        kind: "pro",
        stripePriceId: "price_cockroach_test_pro",
        stripeProductId: "product_cockroach_test_pro",
        unitAmount: 1,
        currency: "usd",
        recurringInterval: "month",
        recurringIntervalCount: 1,
      },
      update: {},
    });
    await upsertSubscription({
      userId: USER_ID,
      stripeSubscriptionId: `sub-${crypto.randomUUID()}`,
      status: "active",
      planId: "pro",
      billingOfferId: billingOffer.id,
      currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2099-09-01T00:00:00.000Z"),
    });
  });

  afterEach(async () => {
    await prisma.stripeCreditReversal.deleteMany({
      where: { stripePaymentId: { startsWith: "pi-cockroach-" } },
    });
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'DELETE FROM "User" WHERE "id" = $1',
      USER_ID,
    );
    await prisma.$disconnect();
  });

  it("does not overdraw the monthly allowance under concurrent reservations", async () => {
    const reserve = async () =>
      await createReservedAiJob({
        userId: USER_ID,
        kind: "image",
        provider: "test",
        status: "running",
        usageUnits: 300,
      });

    const results = await Promise.all([reserve(), reserve()]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter(
        (result) => !result.ok && result.errorCode === "aiUsageLimitExceeded",
      ),
    ).toHaveLength(1);
    const account = await prisma.creditAccount.findUniqueOrThrow({
      where: { userId: USER_ID },
    });
    expect(account.monthlyUsageUsed).toBe(300);
    expect(
      await prisma.creditTransaction.count({
        where: { userId: USER_ID, kind: "usage" },
      }),
    ).toBe(1);
    expect(await prisma.aiJob.count({ where: { userId: USER_ID } })).toBe(1);
  });

  it("enforces the one-video limit transactionally", async () => {
    const reserve = async () =>
      await createReservedAiJob({
        userId: USER_ID,
        kind: "video",
        provider: "test",
        status: "queued",
        usageUnits: 200,
        activeJobLimit: 1,
      });

    const results = await Promise.all([reserve(), reserve()]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter(
        (result) => !result.ok && result.errorCode === "aiJobLimitReached",
      ),
    ).toHaveLength(1);
    expect(await prisma.aiJob.count({ where: { userId: USER_ID } })).toBe(1);
    expect(
      await prisma.creditTransaction.count({
        where: { userId: USER_ID, kind: "usage" },
      }),
    ).toBe(1);
  });

  it("persists reversal debt and settles it before adding new credits", async () => {
    const idSuffix = crypto.randomUUID();
    const originalPaymentId = `pi-cockroach-original-${idSuffix}`;
    const secondPaymentId = `pi-cockroach-second-${idSuffix}`;
    const reversalId = `re-cockroach-${idSuffix}`;

    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: originalPaymentId,
      stripePayment: { amount: 1_000, currency: "usd" },
    });
    const reservation = await createReservedAiJob({
      userId: USER_ID,
      kind: "image",
      provider: "test",
      status: "running",
      usageUnits: 600,
    });
    expect(reservation.ok).toBe(true);

    await reconcilePurchasedCreditReversal({
      stripeEventId: `evt-cockroach-refund-created-${idSuffix}`,
      stripeEventCreatedAt: new Date("2026-08-09T00:00:00.000Z"),
      stripePaymentId: originalPaymentId,
      stripePayment: { amount: 1_000, currency: "usd" },
      reversalKind: "refund",
      reversalId,
      reversalAmount: 1_000,
      reversalCurrency: "usd",
      status: "succeeded",
      active: true,
    });
    let account = await getCreditAccount({ userId: USER_ID });
    expect(account.purchasedCredits).toBe(0);
    expect(account.purchasedCreditDebt).toBe(100);

    await addPurchasedCredits({
      userId: USER_ID,
      amount: 500,
      stripePaymentId: secondPaymentId,
      stripePayment: { amount: 1_000, currency: "usd" },
    });
    account = await getCreditAccount({ userId: USER_ID });
    expect(account.purchasedCredits).toBe(400);
    expect(account.purchasedCreditDebt).toBe(0);

    await reconcilePurchasedCreditReversal({
      stripeEventId: `evt-cockroach-refund-failed-${idSuffix}`,
      stripeEventCreatedAt: new Date("2026-08-09T00:00:01.000Z"),
      stripePaymentId: originalPaymentId,
      stripePayment: { amount: 1_000, currency: "usd" },
      reversalKind: "refund",
      reversalId,
      reversalAmount: 1_000,
      reversalCurrency: "usd",
      status: "failed",
      active: false,
    });
    account = await getCreditAccount({ userId: USER_ID });
    expect(account.purchasedCredits).toBe(900);
    expect(account.purchasedCreditDebt).toBe(0);
  });
});
