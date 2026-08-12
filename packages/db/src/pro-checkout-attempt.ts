import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";

export async function getOrCreateProCheckoutAttempt({
  userId,
  billingOfferId,
  now,
  expiresAt,
  prisma,
}: {
  userId: string;
  billingOfferId: string;
  now: Date;
  expiresAt: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const deletionIntent = await tx.accountDeletionIntent.findFirst({
      where: { userId, expiresAt: { gt: now } },
      select: { userId: true },
    });
    if (deletionIntent) {
      throw new Error("Account deletion is already authorized");
    }

    const existing = await tx.proCheckoutAttempt.findUnique({
      where: { userId },
    });
    // A local expiry is only a lease for an unbound creation key. Once Stripe
    // has assigned a Checkout Session, that Session remains payable until its
    // actual Stripe state has been resolved by the caller.
    if (
      existing &&
      (existing.stripeCheckoutSessionId !== null ||
        (existing.expiresAt.getTime() > now.getTime() &&
          existing.billingOfferId === billingOfferId))
    ) {
      return existing;
    }

    return await tx.proCheckoutAttempt.upsert({
      where: { userId },
      create: {
        userId,
        billingOfferId,
        checkoutKey: crypto.randomUUID(),
        expiresAt,
      },
      update: {
        checkoutKey: crypto.randomUUID(),
        billingOfferId,
        stripeCheckoutSessionId: null,
        expiresAt,
      },
    });
  };

  if (prisma) {
    return await run(prisma);
  }
  return await startRetryableTransaction(run);
}

export async function findProCheckoutAttemptBySessionId({
  userId,
  stripeCheckoutSessionId,
  prisma,
}: {
  userId: string;
  stripeCheckoutSessionId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.proCheckoutAttempt.findFirst({
    where: { userId, stripeCheckoutSessionId },
  });
}

export async function bindProCheckoutSession({
  userId,
  checkoutKey,
  stripeCheckoutSessionId,
  expiresAt,
  now = new Date(),
  prisma,
}: {
  userId: string;
  checkoutKey: string;
  stripeCheckoutSessionId: string;
  expiresAt: Date;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const current = await tx.proCheckoutAttempt.findUnique({
      where: { userId },
    });
    const deletionIntent = await tx.accountDeletionIntent.findFirst({
      where: { userId, expiresAt: { gt: now } },
      select: { userId: true },
    });
    if (deletionIntent) {
      // Preserve the just-created remote handle even though the attempt is no
      // longer redirectable. Account-deletion finalization and the checkout
      // action can then race safely to resolve the exact same Stripe Session.
      if (
        current?.checkoutKey === checkoutKey &&
        (current.stripeCheckoutSessionId === null ||
          current.stripeCheckoutSessionId === stripeCheckoutSessionId)
      ) {
        await tx.proCheckoutAttempt.updateMany({
          where: {
            userId,
            checkoutKey,
            ...(current.stripeCheckoutSessionId === null
              ? { stripeCheckoutSessionId: null }
              : {}),
          },
          data: {
            stripeCheckoutSessionId,
            expiresAt: now,
          },
        });
      }
      return "account-deletion-authorized" as const;
    }
    if (!current || current.checkoutKey !== checkoutKey) {
      return "superseded" as const;
    }
    if (current.stripeCheckoutSessionId === stripeCheckoutSessionId) {
      return "already-bound" as const;
    }
    if (current.stripeCheckoutSessionId !== null) {
      return "superseded" as const;
    }
    const updated = await tx.proCheckoutAttempt.updateMany({
      where: {
        userId,
        checkoutKey,
        stripeCheckoutSessionId: null,
      },
      data: {
        stripeCheckoutSessionId,
        expiresAt,
      },
    });
    return updated.count === 1 ? "bound" as const : "superseded" as const;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function deleteBoundProCheckoutAttempt({
  userId,
  checkoutKey,
  stripeCheckoutSessionId,
  prisma,
}: {
  userId: string;
  checkoutKey: string;
  stripeCheckoutSessionId: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? await getDb();
  const deleted = await db.proCheckoutAttempt.deleteMany({
    where: { userId, checkoutKey, stripeCheckoutSessionId },
  });
  return deleted.count === 1;
}

export async function expireProCheckoutAttempt({
  userId,
  checkoutKey,
  now,
  prisma,
}: {
  userId: string;
  checkoutKey: string;
  now: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  await db.proCheckoutAttempt.updateMany({
    where: {
      userId,
      checkoutKey,
    },
    data: {
      expiresAt: now,
    },
  });
}

export async function deleteProCheckoutAttempt({
  userId,
  stripeCheckoutSessionId,
  prisma,
}: {
  userId: string;
  stripeCheckoutSessionId: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? await getDb();
  const deleted = await db.proCheckoutAttempt.deleteMany({
    where: { userId, stripeCheckoutSessionId },
  });
  return deleted.count === 1;
}
