import { getDb } from "./provider";
import { startTransaction, type PrismaTransaction } from "./transaction";

export const PACKAGE_PAYMENT_EVENT_RANK = {
  paymentSucceeded: 10,
  disputeRevoked: 20,
  disputeRestored: 30,
  refundSucceeded: 40,
} as const;

const PACKAGE_PAYMENT_TRANSACTION_MAX_ATTEMPTS = 3;
const PACKAGE_PAYMENT_TRANSACTION_RETRY_BASE_DELAY_MS = 10;
const PACKAGE_PAYMENT_TRANSACTION_RETRY_CODES = new Set(["P2002", "P2034"]);

export type PackagePaymentReference = {
  paymentId: string;
  userId: string;
  packageId: string;
};

export type PackagePaymentBilling = {
  amount: number;
  currency: string;
};

export type PackagePaymentStateEvent = {
  id: string;
  createdAt: Date;
  rank: number;
};

export type PackagePaymentStateResult = PackagePaymentReference & {
  active: boolean;
  changed: boolean;
};

export type PackagePaymentRecord = PackagePaymentReference & {
  fulfillmentValidated: boolean;
  revokedAt: Date | null;
  stripeStateEventRank: number;
};

type PaymentHistoryState = PackagePaymentReference & {
  fulfillmentValidated: boolean;
  revokedAt: Date | null;
  stripeStateEventId: string | null;
  stripeStateEventCreatedAt: Date | null;
  stripeStateEventRank: number;
};

const paymentStateSelect = {
  paymentId: true,
  userId: true,
  packageId: true,
  fulfillmentValidated: true,
  revokedAt: true,
  stripeStateEventId: true,
  stripeStateEventCreatedAt: true,
  stripeStateEventRank: true,
} as const;

function isRetryablePackagePaymentTransactionError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      PACKAGE_PAYMENT_TRANSACTION_RETRY_CODES.has(error.code),
  );
}

async function startPackagePaymentTransaction<T>(
  callback: (tx: PrismaTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startTransaction(callback);
    } catch (error) {
      if (
        attempt >= PACKAGE_PAYMENT_TRANSACTION_MAX_ATTEMPTS ||
        !isRetryablePackagePaymentTransactionError(error)
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          PACKAGE_PAYMENT_TRANSACTION_RETRY_BASE_DELAY_MS * attempt,
        ),
      );
    }
  }
}

function validateEvent(event: PackagePaymentStateEvent): void {
  if (!event.id || Number.isNaN(event.createdAt.getTime())) {
    throw new TypeError("Stripe package-payment event is invalid");
  }
  if (!Number.isSafeInteger(event.rank) || event.rank < 0) {
    throw new RangeError("Stripe package-payment event rank is invalid");
  }
}

function isNewerEvent(
  current: PaymentHistoryState,
  incoming: PackagePaymentStateEvent,
): boolean {
  if (
    current.stripeStateEventRank ===
      PACKAGE_PAYMENT_EVENT_RANK.refundSucceeded &&
    incoming.rank < PACKAGE_PAYMENT_EVENT_RANK.refundSucceeded
  ) {
    return false;
  }
  if (!current.stripeStateEventCreatedAt) {
    return true;
  }
  const currentTime = current.stripeStateEventCreatedAt.getTime();
  const incomingTime = incoming.createdAt.getTime();
  if (incomingTime !== currentTime) {
    return incomingTime > currentTime;
  }
  if (incoming.rank !== current.stripeStateEventRank) {
    return incoming.rank > current.stripeStateEventRank;
  }
  return incoming.id > (current.stripeStateEventId ?? "");
}

function assertSameReference(
  current: PackagePaymentReference,
  reference: PackagePaymentReference,
): void {
  if (
    current.paymentId !== reference.paymentId ||
    current.userId !== reference.userId ||
    current.packageId !== reference.packageId
  ) {
    throw new Error("Package payment identity cannot be rebound");
  }
}

async function reconcileLibraryEntitlement(
  tx: PrismaTransaction,
  state: PaymentHistoryState,
): Promise<void> {
  if (state.fulfillmentValidated && !state.revokedAt) {
    const pkg = await tx.package.findFirst({
      where: { id: state.packageId },
      select: { id: true },
    });
    if (!pkg) {
      return;
    }
    await tx.userPackage.upsert({
      where: {
        userId_packageId: {
          userId: state.userId,
          packageId: state.packageId,
        },
      },
      create: {
        userId: state.userId,
        packageId: state.packageId,
        paymentManaged: true,
      },
      update: {},
    });
    return;
  }

  const activePayments = await tx.userPaymentHistory.count({
    where: {
      userId: state.userId,
      packageId: state.packageId,
      fulfillmentValidated: true,
      revokedAt: null,
    },
  });
  if (activePayments === 0) {
    await tx.userPackage.deleteMany({
      where: {
        userId: state.userId,
        packageId: state.packageId,
        paymentManaged: true,
      },
    });
  }
}

async function applyPackagePaymentState({
  active,
  allowReactivation,
  event,
  reason,
  reference,
  validateFulfillment,
  tx,
}: {
  active: boolean;
  allowReactivation: boolean;
  event: PackagePaymentStateEvent;
  reason?: string;
  reference?: PackagePaymentReference;
  validateFulfillment: boolean;
  tx: PrismaTransaction;
}): Promise<PackagePaymentStateResult | null> {
  validateEvent(event);
  const paymentId = reference?.paymentId;
  if (!paymentId) {
    return null;
  }

  const existing = await tx.userPaymentHistory.findUnique({
    where: { paymentId },
    select: paymentStateSelect,
  });
  let state: PaymentHistoryState;
  let changed = false;
  let shouldReconcileEntitlement = false;

  if (!existing) {
    state = await tx.userPaymentHistory.create({
      data: {
        paymentId: reference.paymentId,
        userId: reference.userId,
        packageId: reference.packageId,
        fulfillmentValidated: validateFulfillment,
        revokedAt: active ? null : event.createdAt,
        revocationReason: active ? null : reason ?? "payment reversed",
        stripeStateEventId: event.id,
        stripeStateEventCreatedAt: event.createdAt,
        stripeStateEventRank: event.rank,
      },
      select: paymentStateSelect,
    });
    changed = true;
    shouldReconcileEntitlement = true;
  } else {
    assertSameReference(existing, reference);
    state = existing;
    const shouldValidateFulfillment =
      validateFulfillment && !existing.fulfillmentValidated;
    const mayReactivate = !active || !existing.revokedAt || allowReactivation;
    const shouldApplyEvent = mayReactivate && isNewerEvent(existing, event);
    if (shouldValidateFulfillment || shouldApplyEvent) {
      changed = shouldApplyEvent && Boolean(existing.revokedAt) === active;
      state = await tx.userPaymentHistory.update({
        where: { paymentId },
        data: {
          ...(shouldValidateFulfillment
            ? { fulfillmentValidated: true }
            : {}),
          ...(shouldApplyEvent
            ? {
                revokedAt: active ? null : event.createdAt,
                revocationReason: active
                  ? null
                  : reason ?? "payment reversed",
                stripeStateEventId: event.id,
                stripeStateEventCreatedAt: event.createdAt,
                stripeStateEventRank: event.rank,
              }
            : {}),
        },
        select: paymentStateSelect,
      });
      shouldReconcileEntitlement = active
        ? changed || (shouldValidateFulfillment && !state.revokedAt)
        : shouldApplyEvent || shouldValidateFulfillment;
    }
  }

  if (shouldReconcileEntitlement) {
    await reconcileLibraryEntitlement(tx, state);
  }
  return {
    paymentId: state.paymentId,
    userId: state.userId,
    packageId: state.packageId,
    active: state.revokedAt === null,
    changed,
  };
}

export async function findPackagePaymentReference({
  paymentId,
  prisma,
}: {
  paymentId: string;
  prisma?: PrismaTransaction;
}): Promise<PackagePaymentRecord | null> {
  const db = prisma ?? await getDb();
  return await db.userPaymentHistory.findUnique({
    where: { paymentId },
    select: {
      paymentId: true,
      userId: true,
      packageId: true,
      fulfillmentValidated: true,
      revokedAt: true,
      stripeStateEventRank: true,
    },
  });
}

export async function recordPackagePaymentSucceeded({
  reference,
  billing,
  event,
  prisma,
}: {
  reference: PackagePaymentReference;
  billing: PackagePaymentBilling;
  event: PackagePaymentStateEvent;
  prisma?: PrismaTransaction;
}): Promise<PackagePaymentStateResult | null> {
  if (
    !Number.isSafeInteger(billing.amount) ||
    billing.amount <= 0 ||
    billing.currency.trim().length === 0
  ) {
    throw new TypeError("Package payment billing data is invalid");
  }

  const record = async (tx: PrismaTransaction) => {
    const existing = await findPackagePaymentReference({
      paymentId: reference.paymentId,
      prisma: tx,
    });
    if (existing) {
      assertSameReference(existing, reference);
    }
    if (!existing?.fulfillmentValidated) {
      const pkg = await tx.package.findFirst({
        where: {
          id: reference.packageId,
          published: true,
          packagePricing: {
            some: {
              price: billing.amount,
              currency: {
                equals: billing.currency,
                mode: "insensitive",
              },
            },
          },
        },
        select: { id: true },
      });
      if (!pkg) {
        return null;
      }
    }
    return await applyPackagePaymentState({
      active: true,
      allowReactivation: false,
      event,
      reference,
      validateFulfillment: true,
      tx,
    });
  };
  return prisma
    ? await record(prisma)
    : await startPackagePaymentTransaction(record);
}

export async function revokePackagePayment({
  paymentId,
  reference,
  event,
  reason,
  prisma,
}: {
  paymentId: string;
  reference?: Omit<PackagePaymentReference, "paymentId">;
  event: PackagePaymentStateEvent;
  reason: string;
  prisma?: PrismaTransaction;
}): Promise<PackagePaymentStateResult | null> {
  const revoke = async (tx: PrismaTransaction) => {
    const existing = await findPackagePaymentReference({
      paymentId,
      prisma: tx,
    });
    const resolvedReference =
      existing ?? (reference ? { paymentId, ...reference } : undefined);
    return await applyPackagePaymentState({
      active: false,
      allowReactivation: false,
      event,
      reason,
      reference: resolvedReference,
      validateFulfillment: false,
      tx,
    });
  };
  return prisma
    ? await revoke(prisma)
    : await startPackagePaymentTransaction(revoke);
}

export async function restorePackagePayment({
  paymentId,
  reference,
  event,
  prisma,
}: {
  paymentId: string;
  reference?: Omit<PackagePaymentReference, "paymentId">;
  event: PackagePaymentStateEvent;
  prisma?: PrismaTransaction;
}): Promise<PackagePaymentStateResult | null> {
  const restore = async (tx: PrismaTransaction) => {
    const existing = await findPackagePaymentReference({
      paymentId,
      prisma: tx,
    });
    if (!existing?.fulfillmentValidated) {
      return null;
    }
    if (reference) {
      assertSameReference(existing, { paymentId, ...reference });
    }
    return await applyPackagePaymentState({
      active: true,
      allowReactivation: true,
      event,
      reference: existing,
      validateFulfillment: false,
      tx,
    });
  };
  return prisma
    ? await restore(prisma)
    : await startPackagePaymentTransaction(restore);
}
