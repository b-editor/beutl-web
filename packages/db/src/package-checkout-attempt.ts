import { getDb } from "./provider";
import { startRetryableTransaction, type PrismaTransaction } from "./transaction";
import { scheduleStripeCheckoutCleanup } from "./stripe-checkout-cleanup";

export const PACKAGE_CHECKOUT_ATTEMPT_METADATA_KEY = "packageCheckoutAttemptId";

export function withPackageCheckoutAttemptToken(paramsJson: string, attemptToken: string): string {
  const params = JSON.parse(paramsJson) as Record<string, unknown>;
  const metadata = { ...((params.metadata as Record<string, unknown> | undefined) ?? {}), [PACKAGE_CHECKOUT_ATTEMPT_METADATA_KEY]: attemptToken };
  const paymentIntentRecord = params.payment_intent_data as Record<string, unknown> | undefined;
  const paymentIntentData = paymentIntentRecord && typeof paymentIntentRecord === "object"
    ? { ...paymentIntentRecord, metadata: { ...((paymentIntentRecord.metadata as Record<string, unknown> | undefined) ?? {}), [PACKAGE_CHECKOUT_ATTEMPT_METADATA_KEY]: attemptToken } }
    : params.payment_intent_data;
  return JSON.stringify({ ...params, metadata, ...(paymentIntentData === undefined ? {} : { payment_intent_data: paymentIntentData }) });
}

export function withoutPackageCheckoutAttemptToken(params: unknown): unknown {
  if (!params || typeof params !== "object") return params;
  const value = params as Record<string, unknown>;
  const metadata = value.metadata && typeof value.metadata === "object" ? { ...(value.metadata as Record<string, unknown>) } : value.metadata;
  if (metadata && typeof metadata === "object") delete (metadata as Record<string, unknown>)[PACKAGE_CHECKOUT_ATTEMPT_METADATA_KEY];
  const paymentIntentData = value.payment_intent_data && typeof value.payment_intent_data === "object"
    ? { ...(value.payment_intent_data as Record<string, unknown>) }
    : value.payment_intent_data;
  const paymentIntentRecord = paymentIntentData as Record<string, unknown> | undefined;
  if (paymentIntentRecord && paymentIntentRecord.metadata && typeof paymentIntentRecord.metadata === "object") {
    const paymentMetadata = { ...(paymentIntentRecord.metadata as Record<string, unknown>) };
    delete paymentMetadata[PACKAGE_CHECKOUT_ATTEMPT_METADATA_KEY];
    paymentIntentRecord.metadata = paymentMetadata;
  }
  return { ...value, ...(metadata === undefined ? {} : { metadata }), ...(paymentIntentData === undefined ? {} : { payment_intent_data: paymentIntentData }) };
}

function logicalParamsEqual(existingJson: string, currentJson: string): boolean {
  try {
    return JSON.stringify(withoutPackageCheckoutAttemptToken(JSON.parse(existingJson))) === JSON.stringify(withoutPackageCheckoutAttemptToken(JSON.parse(currentJson)));
  } catch {
    return false;
  }
}

export async function getOrCreatePackageCheckoutAttempt({
  userId,
  packageId,
  fingerprint,
  customerId,
  paramsJson,
  expiresAt,
  now = new Date(),
  prisma,
}: {
  userId: string;
  packageId: string;
  fingerprint: string;
  customerId: string;
  paramsJson: string;
  expiresAt: Date;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const pkg = await tx.package.findUnique({ where: { id: packageId }, select: { id: true, userId: true } });
    if (!pkg) throw new Error("Package no longer exists");
    const sellerIntent = await tx.accountDeletionIntent.findFirst({ where: { userId: pkg.userId, expiresAt: { gt: now } }, select: { userId: true } });
    if (sellerIntent) throw new Error("Package seller account deletion is already authorized");
    const deletionIntent = await tx.accountDeletionIntent.findFirst({
      where: { userId, expiresAt: { gt: now } },
      select: { userId: true },
    });
    if (deletionIntent) {
      throw new Error("Account deletion is already authorized");
    }

    const existing = await tx.packageCheckoutAttempt.findUnique({
      where: { userId_packageId: { userId, packageId } },
    });
    if (existing?.accountDeletionAt) {
      throw new Error("Account deletion is already authorized");
    }
    if (existing) {
      const resolution = await tx.packageCheckoutResolution.findFirst({
        where: { attemptId: existing.id, status: "refund_pending" },
        select: { id: true },
      });
      if (resolution) throw new Error("Package Checkout attempt is awaiting duplicate payment refunds");
    }
    if (existing && existing.stripeCheckoutSessionId !== null) {
      // A bound remote Session remains the durable handle until its Stripe
      // status has been resolved. Local expiry never clears that handle.
      return existing;
    }
    if (existing?.status === "open" && existing.fingerprint === fingerprint && logicalParamsEqual(existing.paramsJson, paramsJson)) {
      return existing;
    }

    // Return an unbound attempt even when its local lease or fingerprint has
    // changed. The caller must discover and resolve its durable attempt token
    // on Stripe before a new row/key can be created.
    if (existing && existing.stripeCheckoutSessionId === null && existing.status === "open") {
      return existing;
    }
    if (existing && existing.status === "intervention") {
      return existing;
    }
    if (existing && existing.status === "recovering") {
      throw new Error("Package Checkout attempt requires operator intervention");
    }

    const attemptId = existing?.id ?? crypto.randomUUID();
    const existingDiscoveryToken = (existing as typeof existing & { discoveryToken?: string } | null)?.discoveryToken;
    const startsNewGeneration = existing?.status === "terminal" || existing?.status === "intervention";
    const discoveryToken = startsNewGeneration ? crypto.randomUUID() : (existingDiscoveryToken ?? crypto.randomUUID());
    const persistedParamsJson = withPackageCheckoutAttemptToken(paramsJson, discoveryToken);
    return await tx.packageCheckoutAttempt.upsert({
      where: { userId_packageId: { userId, packageId } },
      create: {
        id: attemptId,
        discoveryToken,
        userId,
        packageId,
        fingerprint,
        customerId,
        paramsJson: persistedParamsJson,
        checkoutKey: crypto.randomUUID(),
        expiresAt,
      },
      update: {
        fingerprint,
        paramsJson: persistedParamsJson,
        discoveryToken,
        checkoutKey: crypto.randomUUID(),
        stripeCheckoutSessionId: null,
        ...(customerId ? { customerId } : {}),
        status: "open",
        expiresAt,
        ...(startsNewGeneration ? { createdAt: now } : {}),
      },
    });
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function markPackageCheckoutAttemptIntervention({
  id,
  checkoutKey,
  discoveryToken,
  createLeaseToken,
  lastError,
  now = new Date(),
  prisma,
}: {
  id: string;
  checkoutKey: string;
  discoveryToken?: string;
  createLeaseToken?: string;
  lastError: string;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutAttempt.updateMany({
    where: { id, checkoutKey, stripeCheckoutSessionId: null, status: { in: ["open", "recovering"] }, ...(discoveryToken ? { discoveryToken } : {}), ...(createLeaseToken ? { createLeaseToken } : {}) },
    data: { status: "intervention", recoveryInterventionAt: now, recoveryLastError: lastError, recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, ...(createLeaseToken ? { createLeaseToken: null, createLeaseExpiresAt: null } : {}) },
  });
}

export async function claimPackageCheckoutInterventions({ now, leaseToken, leaseExpiresAt, limit = 50, prisma }: { now: Date; leaseToken: string; leaseExpiresAt: Date; limit?: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const rows = await db.packageCheckoutAttempt.findMany({ where: { status: "intervention", OR: [{ recoveryLeaseExpiresAt: null }, { recoveryLeaseExpiresAt: { lte: now } }], AND: [{ OR: [{ recoveryNotBefore: null }, { recoveryNotBefore: { lte: now } }] }] }, orderBy: { updatedAt: "asc" }, take: limit });
  const claimed = [];
  for (const row of rows) {
    const updated = await db.packageCheckoutAttempt.updateMany({ where: { id: row.id, status: "intervention", recoveryLeaseToken: row.recoveryLeaseToken, OR: [{ recoveryLeaseExpiresAt: null }, { recoveryLeaseExpiresAt: { lte: now } }] }, data: { recoveryLeaseToken: leaseToken, recoveryLeaseExpiresAt: leaseExpiresAt } });
    if (updated.count === 1) claimed.push({ ...row, recoveryLeaseToken: leaseToken, recoveryLeaseExpiresAt: leaseExpiresAt });
  }
  return claimed;
}

export async function claimPackageCheckoutInterventionById({ id, discoveryToken, now, leaseToken, leaseExpiresAt, prisma }: { id: string; discoveryToken: string; now: Date; leaseToken: string; leaseExpiresAt: Date; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const updated = await db.packageCheckoutAttempt.updateMany({ where: { id, discoveryToken, status: "intervention", OR: [{ recoveryLeaseExpiresAt: null }, { recoveryLeaseExpiresAt: { lte: now } }] }, data: { recoveryLeaseToken: leaseToken, recoveryLeaseExpiresAt: leaseExpiresAt } });
  if (updated.count !== 1) return null;
  return await db.packageCheckoutAttempt.findUnique({ where: { id } });
}

export async function reschedulePackageCheckoutIntervention({ id, discoveryToken, leaseToken, notBefore, lastError, prisma }: { id: string; discoveryToken: string; leaseToken: string; notBefore: Date; lastError: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutAttempt.updateMany({ where: { id, discoveryToken, status: "intervention", recoveryLeaseToken: leaseToken }, data: { recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, recoveryNotBefore: notBefore, recoveryLastError: lastError } });
}

export async function terminalizePackageCheckoutIntervention({ id, discoveryToken, leaseToken, lastError, prisma }: { id: string; discoveryToken: string; leaseToken: string; lastError: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutAttempt.updateMany({ where: { id, discoveryToken, status: "intervention", recoveryLeaseToken: leaseToken, stripeCheckoutSessionId: null }, data: { status: "terminal", recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, recoveryNotBefore: null, recoveryInterventionAt: null, recoveryLastError: lastError } });
}

export async function bindPackageCheckoutIntervention({ id, discoveryToken, leaseToken, stripeCheckoutSessionId, expiresAt, prisma }: { id: string; discoveryToken: string; leaseToken: string; stripeCheckoutSessionId: string; expiresAt: Date; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutAttempt.updateMany({ where: { id, discoveryToken, status: "intervention", recoveryLeaseToken: leaseToken, stripeCheckoutSessionId: null }, data: { status: "open", stripeCheckoutSessionId, expiresAt, recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, recoveryNotBefore: null, recoveryInterventionAt: null, recoveryLastError: null } });
}

export async function claimPackageCheckoutCreateLease({ id, checkoutKey, discoveryToken, leaseToken, now = new Date(), leaseExpiresAt = new Date(now.getTime() + 10 * 60_000), prisma }: { id: string; checkoutKey: string; discoveryToken: string; leaseToken: string; now?: Date; leaseExpiresAt?: Date; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutAttempt.updateMany({ where: { id, checkoutKey, discoveryToken, status: "open", OR: [{ createLeaseExpiresAt: null }, { createLeaseExpiresAt: { lte: now } }] }, data: { createLeaseToken: leaseToken, createLeaseExpiresAt: leaseExpiresAt } });
}

export async function releasePackageCheckoutCreateLease({ id, leaseToken, prisma }: { id: string; leaseToken: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutAttempt.updateMany({ where: { id, createLeaseToken: leaseToken }, data: { createLeaseToken: null, createLeaseExpiresAt: null } });
}

export async function terminalizePackageCheckoutUnderCreateLease({ id, checkoutKey, discoveryToken, createLeaseToken, stripeCheckoutSessionId, prisma }: { id: string; checkoutKey: string; discoveryToken: string; createLeaseToken: string; stripeCheckoutSessionId: string | null; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutAttempt.updateMany({ where: { id, checkoutKey, discoveryToken, createLeaseToken, status: "open", stripeCheckoutSessionId }, data: { status: "terminal", stripeCheckoutSessionId: null, createLeaseToken: null, createLeaseExpiresAt: null } });
}

export async function resolvePackageCheckoutAttemptIntervention({
  id,
  checkoutKey,
  discoveryToken,
  remoteResolution,
  prisma,
}: {
  id: string;
  checkoutKey: string;
  discoveryToken: string;
  remoteResolution: { status: "expired"; sessionId: string } | { status: "terminal-complete"; sessionId: string; paymentIntentId: string; paymentStatus: string } | { status: "absent-after-exhaustive-discovery"; checkedAt: Date; discoveryToken: string };
  prisma?: PrismaTransaction;
}) {
  if (remoteResolution.status === "expired" && !remoteResolution.sessionId) throw new Error("Operator recovery requires an evidenced remote Session id");
  if (remoteResolution.status === "absent-after-exhaustive-discovery" && (remoteResolution.discoveryToken.length === 0 || remoteResolution.discoveryToken !== discoveryToken)) throw new Error("Operator recovery requires the current discovered token");
  const db = prisma ?? await getDb();
  return await db.packageCheckoutAttempt.updateMany({
    where: { id, checkoutKey, discoveryToken, status: "intervention", stripeCheckoutSessionId: null },
    data: { status: "terminal", recoveryInterventionAt: null, recoveryLastError: `Operator confirmed ${remoteResolution.status}`, recoveryNotBefore: null },
  });
}

export async function ensurePackageCheckoutAttemptToken({ id, checkoutKey, discoveryToken, paramsJson, prisma }: { id: string; checkoutKey: string; discoveryToken: string; paramsJson: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const persisted = withPackageCheckoutAttemptToken(paramsJson, discoveryToken);
  return await db.packageCheckoutAttempt.updateMany({ where: { id, checkoutKey, stripeCheckoutSessionId: null, status: { in: ["open", "intervention"] } }, data: { paramsJson: persisted } });
}

export async function bindPackageCheckoutSession({
  id,
  checkoutKey,
  stripeCheckoutSessionId,
  expiresAt,
  prisma,
  createLeaseToken,
}: {
  id: string;
  checkoutKey: string;
  stripeCheckoutSessionId: string;
  expiresAt: Date;
  prisma?: PrismaTransaction;
  createLeaseToken?: string;
}): Promise<
  "bound" | "already-bound" | "superseded" | "owned" | "account-deletion-authorized"
> {
  const run = async (tx: PrismaTransaction) => {
    const current = await tx.packageCheckoutAttempt.findUnique({ where: { id } });
    const deletionIntent = current
      ? await tx.accountDeletionIntent.findFirst({
          where: { userId: current.userId, expiresAt: { gt: new Date() } },
          select: { userId: true },
        })
      : null;
    if (deletionIntent || current?.accountDeletionAt) {
      if (current?.checkoutKey === checkoutKey && current.stripeCheckoutSessionId === null) {
        await tx.packageCheckoutAttempt.updateMany({
          where: { id, checkoutKey, stripeCheckoutSessionId: null },
      data: { stripeCheckoutSessionId, expiresAt, ...(createLeaseToken ? { createLeaseToken: null, createLeaseExpiresAt: null } : {}) },
        });
        const customerId = current.customerId;
        if (customerId) {
          await scheduleStripeCheckoutCleanup({
            sessionId: stripeCheckoutSessionId,
            userId: current.userId,
            kind: "package",
            customerId,
            packageId: current.packageId,
            prisma: tx,
          });
        }
      }
      return "account-deletion-authorized" as const;
    }
    if (current) {
      const [ownedPackage, activePayment] = await Promise.all([
        tx.userPackage.findUnique({
          where: { userId_packageId: { userId: current.userId, packageId: current.packageId } },
          select: { userId: true },
        }),
        tx.userPaymentHistory.findFirst({
          where: {
            userId: current.userId,
            packageId: current.packageId,
            fulfillmentValidated: true,
            revokedAt: null,
          },
          select: { paymentId: true },
        }),
      ]);
      if (ownedPackage || activePayment) return "owned" as const;
    }
    if (!current || current.checkoutKey !== checkoutKey) return "superseded" as const;
    if (current.stripeCheckoutSessionId === stripeCheckoutSessionId) return "already-bound" as const;
    if (current.stripeCheckoutSessionId !== null) return "superseded" as const;
    const result = await tx.packageCheckoutAttempt.updateMany({
      where: { id, checkoutKey, status: "open", stripeCheckoutSessionId: null, ...(createLeaseToken ? { createLeaseToken } : {}) },
      data: { stripeCheckoutSessionId, expiresAt, ...(createLeaseToken ? { createLeaseToken: null, createLeaseExpiresAt: null } : {}) },
    });
    return result.count === 1 ? "bound" as const : "superseded" as const;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function bindDiscoveredPackageCheckoutSession({ id, checkoutKey, discoveryToken, stripeCheckoutSessionId, expiresAt, prisma }: { id: string; checkoutKey: string; discoveryToken: string; stripeCheckoutSessionId: string; expiresAt: Date; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutAttempt.updateMany({
    where: { id, checkoutKey, discoveryToken, stripeCheckoutSessionId: null, status: { in: ["open", "intervention"] } },
    data: { stripeCheckoutSessionId, status: "open", expiresAt, recoveryInterventionAt: null, recoveryLastError: null },
  });
}

export async function markPackageCheckoutAttemptTerminal({
  id,
  checkoutKey,
  stripeCheckoutSessionId,
  prisma,
}: {
  id: string;
  checkoutKey: string;
  stripeCheckoutSessionId: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutAttempt.updateMany({
    where: { id, checkoutKey, status: "open", stripeCheckoutSessionId },
    data: { status: "terminal", stripeCheckoutSessionId: null },
  });
}

export async function deletePackageCheckoutAttemptBySessionId({ stripeCheckoutSessionId, prisma }: { stripeCheckoutSessionId: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutAttempt.deleteMany({ where: { stripeCheckoutSessionId } });
}

export async function claimDetachedPackageCheckoutAttempt({ now, leaseToken, leaseExpiresAt, limit = 50, prisma }: { now: Date; leaseToken: string; leaseExpiresAt: Date; limit?: number; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  const attemptTable = db.packageCheckoutAttempt as unknown as { findMany(args: { where: Record<string, unknown>; orderBy: Record<string, unknown>; take: number }): Promise<Array<Record<string, any>>> };
  const candidates = await attemptTable.findMany({
    where: {
      accountDeletionAt: { not: null },
      stripeCheckoutSessionId: { equals: null },
      status: { in: ["open", "recovering"] },
      OR: [{ recoveryLeaseExpiresAt: null }, { recoveryLeaseExpiresAt: { lte: now } }],
      AND: [{ OR: [{ createLeaseExpiresAt: null }, { createLeaseExpiresAt: { lte: now } }] }, { OR: [{ recoveryNotBefore: null }, { recoveryNotBefore: { lte: now } }] }],
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  const claimed: Array<Record<string, any>> = [];
  for (const candidate of candidates) {
    const table = db.packageCheckoutAttempt as unknown as { updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }> };
    const updated = await table.updateMany({
      where: { id: candidate.id, status: candidate.status, stripeCheckoutSessionId: null, recoveryLeaseToken: candidate.recoveryLeaseToken, OR: [{ createLeaseExpiresAt: null }, { createLeaseExpiresAt: { lte: now } }] },
      data: { status: "recovering", recoveryLeaseToken: leaseToken, recoveryLeaseExpiresAt: leaseExpiresAt, recoveryAttempts: { increment: 1 } },
    });
    if (updated.count === 1) claimed.push({ ...candidate, status: "recovering", recoveryLeaseToken: leaseToken, recoveryLeaseExpiresAt: leaseExpiresAt });
  }
  return claimed;
}

export async function bindDetachedPackageCheckoutRecovery({ id, leaseToken, stripeCheckoutSessionId, prisma }: { id: string; leaseToken: string; stripeCheckoutSessionId: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutAttempt.updateMany({ where: { id, status: "recovering", recoveryLeaseToken: leaseToken, stripeCheckoutSessionId: null }, data: { stripeCheckoutSessionId, status: "open", recoveryLeaseToken: null, recoveryLeaseExpiresAt: null } });
}

export async function bindDetachedPackageCheckoutRecoveryAndScheduleCleanup({
  id,
  leaseToken,
  stripeCheckoutSessionId,
  now = new Date(),
  prisma,
}: { id: string; leaseToken: string; stripeCheckoutSessionId: string; now?: Date; prisma?: PrismaTransaction }) {
  const run = async (tx: PrismaTransaction) => {
    const current = await tx.packageCheckoutAttempt.findUnique({ where: { id } });
    if (!current || current.status !== "recovering" || current.recoveryLeaseToken !== leaseToken || current.stripeCheckoutSessionId !== null || !current.customerId) return false;
    const updated = await tx.packageCheckoutAttempt.updateMany({
      where: { id, status: "recovering", recoveryLeaseToken: leaseToken, stripeCheckoutSessionId: null },
      data: { stripeCheckoutSessionId, status: "open", recoveryLeaseToken: null, recoveryLeaseExpiresAt: null },
    });
    if (updated.count !== 1) return false;
    await scheduleStripeCheckoutCleanup({
      sessionId: stripeCheckoutSessionId,
      userId: current.userId,
      kind: "package",
      customerId: current.customerId,
      packageId: current.packageId,
      now,
      prisma: tx,
    });
    return true;
  };
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function markDetachedPackageCheckoutRecoveryTerminal({ id, leaseToken, status = "terminal", prisma }: { id: string; leaseToken: string; status?: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutAttempt.updateMany({ where: { id, status: "recovering", recoveryLeaseToken: leaseToken, stripeCheckoutSessionId: null }, data: { status, recoveryLeaseToken: null, recoveryLeaseExpiresAt: null } });
}

export async function rescheduleDetachedPackageCheckoutRecovery({ id, leaseToken, notBefore = new Date(), lastError, prisma }: { id: string; leaseToken: string; notBefore?: Date; lastError: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutAttempt.updateMany({ where: { id, status: "recovering", recoveryLeaseToken: leaseToken }, data: { status: "open", recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, recoveryNotBefore: notBefore, recoveryLastError: lastError } });
}

export async function markDetachedPackageCheckoutRecoveryIntervention({ id, leaseToken, lastError, prisma }: { id: string; leaseToken: string; lastError: string; prisma?: PrismaTransaction }) {
  const db = prisma ?? await getDb();
  return await db.packageCheckoutAttempt.updateMany({ where: { id, status: "recovering", recoveryLeaseToken: leaseToken }, data: { status: "intervention", recoveryLeaseToken: null, recoveryLeaseExpiresAt: null, recoveryLastError: lastError } });
}

export async function preparePackageDeletionOutboxes({ packageId, now = new Date(), prisma }: { packageId: string; now?: Date; prisma: PrismaTransaction }) {
  const attempts = await prisma.packageCheckoutAttempt.findMany({
    where: { packageId },
    select: { id: true, userId: true, customerId: true, paramsJson: true, packageId: true, stripeCheckoutSessionId: true },
  });
  for (const attempt of attempts) {
    if (!attempt.customerId || !attempt.paramsJson) throw new Error(`Package checkout ${packageId} lacks durable cleanup identity`);
    if (attempt.stripeCheckoutSessionId) {
      await scheduleStripeCheckoutCleanup({ sessionId: attempt.stripeCheckoutSessionId, userId: attempt.userId, kind: "package", customerId: attempt.customerId, packageId: attempt.packageId, now, prisma });
    }
  }
  await prisma.packageCheckoutAttempt.updateMany({ where: { packageId }, data: { accountDeletionAt: now } });
}
