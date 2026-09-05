import { beforeEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_DELETION_INTENT_LIFETIME_MS,
  authorizeAccountDeletionIntent,
  bindProCheckoutSession,
  setDbProvider,
} from "@beutl/db";

type TokenRecord = {
  expires: Date;
  identifier: string;
  purpose: string;
  token: string;
  userId: string;
};

type IntentRecord = {
  authorizedAt: Date;
  expiresAt: Date;
  identifier: string;
  stripeCustomerId: string | null;
  tokenHash: string;
  userId: string;
};

describe("account deletion intent authorization", () => {
  let token: TokenRecord | null;
  let intent: IntentRecord | null;
  let tokenConsumptionCount: number;
  let topUpRefundRequired: boolean;
  let remoteCleanup: { provider: string; providerJobId: string } | null;
  let proCheckoutAttempt: {
    userId: string;
    checkoutKey: string;
    billingOfferId: string;
    stripeCheckoutSessionId: string | null;
    expiresAt: Date;
  } | null;

  beforeEach(() => {
    token = {
      expires: new Date("2026-08-10T00:00:00.000Z"),
      identifier: "owner@example.com",
      purpose: "ACCOUNT_DELETE",
      token: "hashed-token",
      userId: "user-1",
    };
    intent = null;
    tokenConsumptionCount = 0;
    topUpRefundRequired = false;
    remoteCleanup = null;
    proCheckoutAttempt = null;

    let transactionTail = Promise.resolve();
    const prisma: any = {
      accountDeletionIntent: {
        findUnique: async ({ where }: any) => {
          const key = where.identifier_tokenHash;
          return intent?.identifier === key.identifier &&
            intent.tokenHash === key.tokenHash
            ? { ...intent }
            : null;
        },
        findFirst: async ({ where }: any) =>
          intent?.userId === where.userId &&
            (!where.expiresAt || intent.expiresAt > where.expiresAt.gt)
            ? { ...intent }
            : null,
        create: async ({ data }: any) => {
          intent = {
            ...data,
          };
          return { ...intent };
        },
      },
      confirmationToken: {
        findUnique: async ({ where }: any) => {
          const key = where.identifier_token;
          return token?.identifier === key.identifier && token.token === key.token
            ? { ...token }
            : null;
        },
        deleteMany: async ({ where }: any) => {
          if (
            token &&
            token.identifier === where.identifier &&
            token.token === where.token &&
            token.userId === where.userId &&
            token.purpose === where.purpose &&
            token.expires > where.expires.gt
          ) {
            token = null;
            tokenConsumptionCount++;
            return { count: 1 };
          }
          return { count: 0 };
        },
      },
      customer: {
        findUnique: async ({ where }: any) =>
          where.userId === "user-1" ? { stripeId: "cus_legacy" } : null,
      },
      topUpCheckoutAttempt: {
        findUnique: async () => null,
        updateMany: async () => {
          topUpRefundRequired = true;
          return { count: 1 };
        },
        count: async () => 0,
      },
      proCheckoutAttempt: {
        findUnique: async ({ where }: any) =>
          proCheckoutAttempt?.userId === where.userId
            ? { ...proCheckoutAttempt }
            : null,
        updateMany: async ({ where, data }: any) => {
          if (
            !proCheckoutAttempt ||
            proCheckoutAttempt.userId !== where.userId ||
            (where.checkoutKey !== undefined &&
              proCheckoutAttempt.checkoutKey !== where.checkoutKey) ||
            (where.stripeCheckoutSessionId !== undefined &&
              proCheckoutAttempt.stripeCheckoutSessionId !==
                where.stripeCheckoutSessionId)
          ) {
            return { count: 0 };
          }
          proCheckoutAttempt = { ...proCheckoutAttempt, ...data };
          return { count: 1 };
        },
        count: async () => 0,
      },
      packageCheckoutAttempt: {
        findMany: async () => [],
        updateMany: async () => ({ count: 0 }),
        count: async () => 0,
      },
      topUpDuplicateRefundAttempt: { count: async () => 0 },
      topUpCheckoutResolution: {
        findMany: async () => [],
        updateMany: async () => ({ count: 0 }),
        count: async () => 0,
      },
      creditTransaction: { findFirst: async () => null },
      user: { findUnique: async () => ({ id: "user-1" }) },
      package: { findMany: async () => [] },
      stripeCustomerProvisioning: {
        updateMany: async () => ({ count: 0 }),
        count: async () => 0,
      },
      stripeCheckoutCleanup: {
        findUnique: async () => null,
        create: async ({ data }: any) => ({ ...data }),
        update: async ({ data }: any) => ({ ...data }),
      },
      aiJob: {
        findMany: async () => [
          {
            provider: "openrouter",
            providerJobId: "provider-video-1",
          },
        ],
      },
      aiRemoteJobCleanup: {
        upsert: async ({ create }: any) => {
          remoteCleanup = {
            provider: create.provider,
            providerJobId: create.providerJobId,
          };
          return { ...create };
        },
      },
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
        const previous = transactionTail;
        let release!: () => void;
        transactionTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await callback(prisma);
        } finally {
          release();
        }
      },
    };
    setDbProvider(async () => prisma);
  });

  it("atomically consumes once and converges concurrent claims on one intent", async () => {
    const options = {
      identifier: "owner@example.com",
      tokenHash: "hashed-token",
      now: new Date("2026-08-09T00:00:00.000Z"),
    };

    const [first, second] = await Promise.all([
      authorizeAccountDeletionIntent(options),
      authorizeAccountDeletionIntent(options),
    ]);

    expect(first).toMatchObject({
      status: "authorized",
      resumed: false,
      intent: { userId: "user-1", stripeCustomerId: "cus_legacy" },
    });
    expect(second).toMatchObject({
      status: "authorized",
      resumed: true,
      intent: { userId: "user-1", stripeCustomerId: "cus_legacy" },
    });
    expect(tokenConsumptionCount).toBe(1);
    expect(token).toBeNull();
    expect(intent?.expiresAt.getTime()).toBe(
      options.now.getTime() + ACCOUNT_DELETION_INTENT_LIFETIME_MS,
    );
    expect(topUpRefundRequired).toBe(true);
    expect(remoteCleanup).toEqual({
      provider: "openrouter",
      providerJobId: "provider-video-1",
    });
  });

  it("preserves and rejects a Stripe Session bound while deletion authorization wins", async () => {
    const now = new Date("2026-08-09T00:00:00.000Z");
    proCheckoutAttempt = {
      userId: "user-1",
      checkoutKey: "checkout-race",
      billingOfferId: "offer-pro",
      stripeCheckoutSessionId: null,
      expiresAt: new Date("2026-08-10T00:00:00.000Z"),
    };
    const authorizationOptions = {
      identifier: "owner@example.com",
      tokenHash: "hashed-token",
      now,
    };

    const authorizationPromise = authorizeAccountDeletionIntent(
      authorizationOptions,
    );
    const bindingPromise = bindProCheckoutSession({
      userId: "user-1",
      checkoutKey: "checkout-race",
      stripeCheckoutSessionId: "cs_raced",
      expiresAt: new Date("2026-08-10T00:00:00.000Z"),
      now,
    });
    const [authorization, binding] = await Promise.all([
      authorizationPromise,
      bindingPromise,
    ]);

    expect(authorization).toMatchObject({ status: "authorized" });
    expect(binding).toBe("account-deletion-authorized");
    expect(proCheckoutAttempt).toMatchObject({
      stripeCheckoutSessionId: "cs_raced",
      expiresAt: now,
    });
  });

  it("invalidates but preserves a binding that commits just before deletion authorization", async () => {
    const now = new Date("2026-08-09T00:00:00.000Z");
    proCheckoutAttempt = {
      userId: "user-1",
      checkoutKey: "checkout-race",
      billingOfferId: "offer-pro",
      stripeCheckoutSessionId: null,
      expiresAt: new Date("2026-08-10T00:00:00.000Z"),
    };

    const bindingPromise = bindProCheckoutSession({
      userId: "user-1",
      checkoutKey: "checkout-race",
      stripeCheckoutSessionId: "cs_raced",
      expiresAt: new Date("2026-08-10T00:00:00.000Z"),
      now,
    });
    const authorizationPromise = authorizeAccountDeletionIntent({
      identifier: "owner@example.com",
      tokenHash: "hashed-token",
      now,
    });
    const [binding, authorization] = await Promise.all([
      bindingPromise,
      authorizationPromise,
    ]);

    expect(binding).toBe("bound");
    expect(authorization).toMatchObject({ status: "authorized" });
    expect(proCheckoutAttempt).toMatchObject({
      stripeCheckoutSessionId: "cs_raced",
      expiresAt: now,
    });
  });

  it("resumes an existing authorization after the source token has expired", async () => {
    const options = {
      identifier: "owner@example.com",
      tokenHash: "hashed-token",
      now: new Date("2026-08-09T00:00:00.000Z"),
    };
    await authorizeAccountDeletionIntent(options);

    const resumed = await authorizeAccountDeletionIntent({
      ...options,
      now: new Date("2026-08-11T00:00:00.000Z"),
    });

    expect(resumed).toMatchObject({ status: "authorized", resumed: true });
  });

  it("requires fresh authorization after the deletion saga expires", async () => {
    const options = {
      identifier: "owner@example.com",
      tokenHash: "hashed-token",
      now: new Date("2026-08-09T00:00:00.000Z"),
    };
    await authorizeAccountDeletionIntent(options);

    const result = await authorizeAccountDeletionIntent({
      ...options,
      now: new Date(
        options.now.getTime() + ACCOUNT_DELETION_INTENT_LIFETIME_MS,
      ),
    });

    expect(result).toEqual({ status: "expired" });
  });

  it("does not consume an expired token without an existing intent", async () => {
    const result = await authorizeAccountDeletionIntent({
      identifier: "owner@example.com",
      tokenHash: "hashed-token",
      now: new Date("2026-08-11T00:00:00.000Z"),
    });

    expect(result).toEqual({ status: "expired" });
    expect(tokenConsumptionCount).toBe(0);
    expect(token).not.toBeNull();
    expect(intent).toBeNull();
  });
});
