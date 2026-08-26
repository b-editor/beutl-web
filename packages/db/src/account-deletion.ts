import { ConfirmationTokenPurpose } from "@prisma/client";
import { getDb } from "./provider";
import {
  startRetryableTransaction,
  type PrismaTransaction,
} from "./transaction";
import { enqueueUserRemoteAiJobCleanups } from "./ai-job";
import { prepareTopUpsForAccountDeletion } from "./top-up-checkout-attempt";
import { scheduleStripeCheckoutCleanup } from "./stripe-checkout-cleanup";

const intentSelect = {
  identifier: true,
  tokenHash: true,
  userId: true,
  stripeCustomerId: true,
  authorizedAt: true,
  expiresAt: true,
} as const;

export const ACCOUNT_DELETION_INTENT_LIFETIME_MS =
  7 * 24 * 60 * 60 * 1000;

export type AuthorizeAccountDeletionIntentResult =
  | {
      status: "authorized";
      resumed: boolean;
      intent: {
        identifier: string;
        tokenHash: string;
        userId: string;
        stripeCustomerId: string | null;
        authorizedAt: Date;
        expiresAt: Date;
      };
    }
  | { status: "invalid" | "expired" };

export async function prepareAccountDeletionOutboxes({
  userId,
  now = new Date(),
  prisma,
}: {
  userId: string;
  now?: Date;
  prisma: PrismaTransaction;
}): Promise<{ unboundCheckoutRecoveries: number }> {
  const customer = await prisma.customer.findUnique({
    where: { userId },
    select: { stripeId: true },
  });
  const proAttempt = await prisma.proCheckoutAttempt.findUnique({
    where: { userId },
    select: { stripeCheckoutSessionId: true, billingOfferId: true, customerId: true },
  });
  const customerId = customer?.stripeId ?? proAttempt?.customerId;
  if (customerId && proAttempt?.stripeCheckoutSessionId) {
    await scheduleStripeCheckoutCleanup({
      sessionId: proAttempt.stripeCheckoutSessionId,
      userId,
      kind: "pro",
      customerId,
      billingOfferId: proAttempt.billingOfferId,
      now,
      prisma,
    });
  }
  {
    const packageAttempts = await prisma.packageCheckoutAttempt.findMany({
      where: { userId, stripeCheckoutSessionId: { not: null } },
      select: { stripeCheckoutSessionId: true, packageId: true, customerId: true },
    });
    for (const attempt of packageAttempts) {
      if (!attempt.stripeCheckoutSessionId) continue;
      await scheduleStripeCheckoutCleanup({
        sessionId: attempt.stripeCheckoutSessionId,
        userId,
        kind: "package",
        customerId: attempt.customerId,
        packageId: attempt.packageId,
        now,
        prisma,
      });
    }
    const ownedPackages = await prisma.package.findMany({ where: { userId }, select: { id: true } });
    const sellerAttempts = ownedPackages.length > 0
      ? await prisma.packageCheckoutAttempt.findMany({
          where: { packageId: { in: ownedPackages.map((pkg) => pkg.id) } },
          select: { stripeCheckoutSessionId: true, packageId: true, customerId: true, userId: true, paramsJson: true },
        })
      : [];
    for (const attempt of sellerAttempts) {
      if (!attempt.customerId || !attempt.paramsJson) {
        throw new Error(`Package checkout ${attempt.packageId} is missing a durable Customer identity`);
      }
      if (!attempt.stripeCheckoutSessionId) continue;
      await scheduleStripeCheckoutCleanup({
        sessionId: attempt.stripeCheckoutSessionId,
        userId: attempt.userId,
        kind: "package",
        customerId: attempt.customerId,
        packageId: attempt.packageId,
        now,
        prisma,
      });
    }
  }
  // Expiry revokes redirect eligibility while deliberately retaining the bound
  // Stripe Session ID. The remote deletion saga still needs that handle to
  // expire the Session or durably compensate it if Checkout won the race.
  await prisma.proCheckoutAttempt.updateMany({
    where: { userId },
    data: { expiresAt: now, accountDeletionAt: now },
  });
  {
    await prisma.packageCheckoutAttempt.updateMany({
      where: { userId },
      data: { accountDeletionAt: now },
    });
    {
      const ownedPackages = await prisma.package.findMany({ where: { userId }, select: { id: true } });
      if (ownedPackages.length > 0) {
        await prisma.packageCheckoutAttempt.updateMany({
          where: { packageId: { in: ownedPackages.map((pkg) => pkg.id) } },
          data: { accountDeletionAt: now },
        });
      }
    }
  }
  {
    await prisma.stripeCustomerProvisioning.updateMany({
      where: { userId, status: { in: ["pending", "mapping", "cleanup_required"] } },
      data: { status: "cleanup_required", notBefore: now, leaseToken: null, leaseExpiresAt: null },
    });
  }
  await prepareTopUpsForAccountDeletion({ ownerUserId: userId, now, prisma });
  await enqueueUserRemoteAiJobCleanups({ userId, now, prisma });
  const unboundCheckoutRecoveries = await countUnboundAccountDeletionCheckoutAttempts({ userId, prisma });
  return { unboundCheckoutRecoveries };
}

export async function authorizeAccountDeletionIntent({
  identifier,
  tokenHash,
  now = new Date(),
}: {
  identifier: string;
  tokenHash: string;
  now?: Date;
}): Promise<AuthorizeAccountDeletionIntentResult> {
  return await startRetryableTransaction(async (prisma) => {
    const existing = await prisma.accountDeletionIntent.findUnique({
      where: {
        identifier_tokenHash: { identifier, tokenHash },
      },
      select: intentSelect,
    });
    if (existing) {
      if (existing.expiresAt.getTime() <= now.getTime()) {
        return { status: "expired" };
      }
      await prepareAccountDeletionOutboxes({
        prisma,
        userId: existing.userId,
        now,
      });
      return { status: "authorized", resumed: true, intent: existing };
    }

    const token = await prisma.confirmationToken.findUnique({
      where: {
        identifier_token: { identifier, token: tokenHash },
      },
      select: {
        expires: true,
        purpose: true,
        userId: true,
      },
    });
    if (!token || token.purpose !== ConfirmationTokenPurpose.ACCOUNT_DELETE) {
      return { status: "invalid" };
    }
    if (token.expires.getTime() <= now.getTime()) {
      return { status: "expired" };
    }

    const consumed = await prisma.confirmationToken.deleteMany({
      where: {
        identifier,
        token: tokenHash,
        userId: token.userId,
        purpose: ConfirmationTokenPurpose.ACCOUNT_DELETE,
        expires: { gt: now },
      },
    });
    if (consumed.count !== 1) {
      return { status: "invalid" };
    }

    const customer = await prisma.customer.findUnique({
      where: { userId: token.userId },
      select: { stripeId: true },
    });
    const intent = await prisma.accountDeletionIntent.create({
      data: {
        identifier,
        tokenHash,
        userId: token.userId,
        stripeCustomerId: customer?.stripeId ?? null,
        authorizedAt: now,
        expiresAt: new Date(
          now.getTime() + ACCOUNT_DELETION_INTENT_LIFETIME_MS,
        ),
      },
      select: intentSelect,
    });
    await prepareAccountDeletionOutboxes({ prisma, userId: token.userId, now });
    return { status: "authorized", resumed: false, intent };
  });
}

export async function findAccountDeletionIntent({
  identifier,
  tokenHash,
  prisma,
}: {
  identifier: string;
  tokenHash: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.accountDeletionIntent.findUnique({
    where: {
      identifier_tokenHash: { identifier, tokenHash },
    },
    select: intentSelect,
  });
}

export async function findAccountDeletionIntentByUserId({
  userId,
  now = new Date(),
  prisma,
}: {
  userId: string;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.accountDeletionIntent.findFirst({
    where: { userId, expiresAt: { gt: now } },
    select: intentSelect,
  });
}

export type AccountDeletionBillingBlockerCategory =
  | "proCheckout"
  | "buyerPackageCheckout"
  | "sellerPackageCheckout"
  | "topUpCheckout"
  | "topUpRefund"
  | "topUpResolution";

export type AccountDeletionBillingBlockers = Readonly<Record<AccountDeletionBillingBlockerCategory, number>>;

export async function inspectAccountDeletionBillingBlockers({ userId, prisma }: { userId: string; prisma?: PrismaTransaction }): Promise<AccountDeletionBillingBlockers> {
  const db = prisma ?? await getDb();
  const ownedPackages = await db.package.findMany({ where: { userId }, select: { id: true } });
  const [proCheckout, buyerPackageCheckout, sellerPackageCheckout, topUpCheckout, topUpRefund, topUpResolution] = await Promise.all([
    db.proCheckoutAttempt.count({ where: { userId, accountDeletionAt: { not: null }, stripeCheckoutSessionId: null, recoveryCompletedAt: null } }),
    db.packageCheckoutAttempt.count({ where: { userId, accountDeletionAt: { not: null }, stripeCheckoutSessionId: null, status: { in: ["open", "recovering", "intervention"] } } }),
    db.packageCheckoutAttempt.count({ where: { packageId: { in: ownedPackages.map((pkg) => pkg.id) }, accountDeletionAt: { not: null }, stripeCheckoutSessionId: null, status: { in: ["open", "recovering", "intervention"] } } }),
    db.topUpCheckoutAttempt.count({ where: { ownerUserId: userId, accountDeletionAt: { not: null }, stripeCheckoutSessionId: null, status: { in: ["open", "payment_pending", "refund_required", "refund_pending", "refund_failed"] }, refundInterventionAt: null } }),
    db.topUpDuplicateRefundAttempt.count({ where: { ownerUserId: userId, status: { in: ["required", "processing", "retry", "intervention"] } } }),
    db.topUpCheckoutResolution.count({ where: { ownerUserId: userId, status: { in: ["refund_pending", "intervention"] } } }),
  ]);
  return { proCheckout, buyerPackageCheckout, sellerPackageCheckout, topUpCheckout, topUpRefund, topUpResolution };
}

export async function countUnboundAccountDeletionCheckoutAttempts({ userId, prisma }: { userId: string; prisma?: PrismaTransaction }) {
  const blockers = await inspectAccountDeletionBillingBlockers({ userId, prisma });
  return Object.values(blockers).reduce((total, count) => total + count, 0);
}

export async function countActiveStripeCustomerProvisioning({ userId, prisma }: { userId: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.stripeCustomerProvisioning.count({ where: { userId, status: { in: ["pending", "mapping", "cleanup_required"] } } });
}

const ADMIN_ACCOUNT_DELETION_IDENTIFIER = "__admin_account_deletion__";

export type AdminAccountDeletionReservation =
  | { status: "reserved" }
  | {
      status: "blocked";
      reason: "already-authorized" | "subscription" | "checkout" | "customer" | "provisioning";
    };

/**
 * Reserve an account for an administrator and perform the billing preflight
 * under the same transaction that creates the deletion guard. Customer and
 * Checkout binding paths consult AccountDeletionIntent before committing, so
 * they cannot commit a new remote handle after this reservation is visible.
 */
export async function reserveAdminAccountDeletion({
  userId,
  now = new Date(),
  prisma,
}: {
  userId: string;
  now?: Date;
  prisma?: PrismaTransaction;
}): Promise<AdminAccountDeletionReservation> {
  const run = async (tx: PrismaTransaction) => {
    const activeIntent = await tx.accountDeletionIntent.findFirst({
      where: { userId, expiresAt: { gt: now } },
      select: { identifier: true, tokenHash: true },
    });
    if (activeIntent) {
      await prepareAccountDeletionOutboxes({ userId, now, prisma: tx });
      const pendingProvisioning = await tx.stripeCustomerProvisioning.count({ where: { userId, status: { in: ["pending", "mapping", "cleanup_required"] } } });
      if (pendingProvisioning > 0) return { status: "blocked", reason: "provisioning" } as const;
      const blockers = await inspectAccountDeletionBillingBlockers({ userId, prisma: tx });
      return Object.values(blockers).some((count) => count > 0)
        ? { status: "blocked", reason: "checkout" } as const
        : { status: "reserved" } as const;
    }

    const identifier = `${ADMIN_ACCOUNT_DELETION_IDENTIFIER}:${userId}`;
    const tokenHash = identifier;
    const customer = await tx.customer.findUnique({
      where: { userId },
      select: { stripeId: true },
    });
    const subscription = await tx.subscription.findUnique({
      where: { userId },
      select: { status: true },
    });
    if (
      subscription &&
      subscription.status !== "canceled" &&
      subscription.status !== "incomplete_expired"
    ) {
      return { status: "blocked", reason: "subscription" } as const;
    }
    await tx.accountDeletionIntent.upsert({
      where: { identifier_tokenHash: { identifier, tokenHash } },
      create: {
        identifier,
        tokenHash,
        userId,
        stripeCustomerId: customer?.stripeId ?? null,
        authorizedAt: now,
        expiresAt: new Date(now.getTime() + ACCOUNT_DELETION_INTENT_LIFETIME_MS),
      },
      update: {
        userId,
        stripeCustomerId: customer?.stripeId ?? null,
        authorizedAt: now,
        expiresAt: new Date(now.getTime() + ACCOUNT_DELETION_INTENT_LIFETIME_MS),
      },
    });
    await prepareAccountDeletionOutboxes({ userId, now, prisma: tx });
    const pendingProvisioning = await tx.stripeCustomerProvisioning.count({ where: { userId, status: { in: ["pending", "mapping", "cleanup_required"] } } });
    if (pendingProvisioning > 0) return { status: "blocked", reason: "provisioning" } as const;
    const blockers = await inspectAccountDeletionBillingBlockers({ userId, prisma: tx });
    if (Object.values(blockers).some((count) => count > 0)) return { status: "blocked", reason: "checkout" } as const;

    const checkoutCleanup = await tx.stripeCheckoutCleanup.findFirst({
      where: { userId, status: { in: ["required", "retry"] } },
      select: { id: true },
    });
    if (checkoutCleanup) return { status: "blocked", reason: "checkout" } as const;

    return { status: "reserved" } as const;
  };

  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}
