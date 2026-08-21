// In-memory Prisma implementation for contract tests. It implements only the
// models used by @beutl/db for monthly usage, purchased credits, AI jobs,
// subscriptions, and files.
//
// $transaction snapshots the store and restores it when the callback throws, so
// discard-on-failure is reproduced. What it does NOT reproduce is concurrency:
// transactions are serialized through one queue, so no test can observe an
// interleaving or provoke a serialization retry. A rule that depends on
// SERIALIZABLE ordering has to be checked against CockroachDB in
// tests/integration.

type CreditAccount = {
  userId: string;
  monthlyUsageUsed: number;
  usagePeriodStart: Date | null;
  usagePeriodEnd: Date | null;
  purchasedCredits: number;
  purchasedCreditDebt: number;
  createdAt: Date;
  updatedAt: Date;
};

type CreditTransaction = {
  id: string;
  userId: string;
  creditAmount: number;
  debtAmount: number;
  usageAmount: number;
  usagePeriodStart: Date | null;
  usagePeriodEnd: Date | null;
  kind: string;
  aiJobId: string | null;
  stripePaymentId: string | null;
  stripePaymentAmount: number | null;
  stripeCurrency: string | null;
  stripeSourcePaymentId: string | null;
  stripeReversalKind: string | null;
  stripeReversalId: string | null;
  stripeReversalRevision: number | null;
  adminAdjustmentKey: string | null;
  createdAt: Date;
};

type StripeCreditReversal = {
  id: string;
  stripePaymentId: string;
  stripeReversalKind: string;
  stripeReversalId: string;
  stripeAmount: number;
  stripeCurrency: string;
  status: string;
  active: boolean;
  progressionRank: number;
  stripeEventId: string | null;
  stripeEventCreatedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

type AiJob = {
  id: string;
  userId: string;
  kind: string;
  provider: string;
  providerJobId: string | null;
  idempotencyKeyHash: string | null;
  requestFingerprint: string | null;
  callbackNonceHash: string | null;
  status: string;
  inputParams: unknown;
  model: string | null;
  resultFileId: string | null;
  usageUnits: number;
  error: string | null;
  providerPollLeaseExpiresAt: Date | null;
  finalizationToken: string | null;
  finalizationLeaseExpiresAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type AiStorageCleanup = {
  objectKey: string;
  aiJobId: string | null;
  state: string;
  notBefore: Date;
  createdAt: Date;
  updatedAt: Date;
};

type AiSetting = {
  key: string;
  value: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type AiOperationModel = {
  operation: string;
  modelId: string;
  priceUnits: number;
  displayName: string | null;
  sortOrder: number;
  enabled: boolean;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type AccountDeletionIntent = {
  identifier: string;
  tokenHash: string;
  userId: string;
  stripeCustomerId: string | null;
  authorizedAt: Date;
  expiresAt: Date;
};

type AiRemoteJobCleanup = {
  provider: string;
  providerJobId: string;
  notBefore: Date;
  leaseExpiresAt: Date | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type Subscription = {
  userId: string;
  stripeSubscriptionId: string;
  status: string;
  planId: string;
  billingOfferId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: Date | null;
  stripeEventId: string | null;
  stripeEventCreatedAt: Date | null;
  stripeCanonicalObservedAt: Date | null;
  stripeObservationRank: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type ProCheckoutAttempt = {
  userId: string;
  checkoutKey: string;
  billingOfferId: string;
  stripeCheckoutSessionId: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type TopUpCheckoutAttempt = {
  id: string;
  ownerUserId: string;
  stripeCustomerId: string;
  billingOfferId: string;
  stripeCheckoutSessionId: string | null;
  stripePaymentIntentId: string | null;
  status: string;
  expiresAt: Date;
  accountDeletionAt: Date | null;
  fulfilledAt: Date | null;
  refundId: string | null;
  refundStatus: string | null;
  refundStatusObservedAt: Date | null;
  refundTargetAmount: number | null;
  refundSucceededAmount: number;
  refundPendingAmount: number;
  refundCurrency: string | null;
  refundNotBefore: Date | null;
  refundLeaseToken: string | null;
  refundLeaseExpiresAt: Date | null;
  refundAttempts: number;
  refundLastError: string | null;
  refundInterventionAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type BillingRefundAttempt = {
  id: string;
  disposition: string;
  sourceKey: string;
  stripeCustomerId: string;
  stripeCheckoutSessionId: string;
  stripeSubscriptionId: string;
  stripeInvoiceId: string | null;
  stripePaymentIntentId: string | null;
  status: string;
  cancellationCompletedAt: Date | null;
  targetAmount: number | null;
  succeededAmount: number;
  pendingAmount: number;
  currency: string | null;
  refundId: string | null;
  refundStatus: string | null;
  refundStatusObservedAt: Date | null;
  notBefore: Date | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  attempts: number;
  lastError: string | null;
  interventionAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type FileRecord = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  objectKey: string;
  userId: string;
  sha256: string | null;
  visibility: string;
  createdAt: Date;
  updatedAt: Date;
};

type BillingOffer = {
  id: string;
  kind: string;
  stripePriceId: string;
  stripeProductId: string;
  unitAmount: number;
  currency: string;
  creditAmount: number | null;
  recurringInterval: string | null;
  recurringIntervalCount: number | null;
  checkoutEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type InMemoryPrismaState = {
  billingOffers: Map<string, BillingOffer>;
  creditAccounts: Map<string, CreditAccount>;
  aiOperationModels: Map<string, AiOperationModel>;
  creditTransactions: CreditTransaction[];
  stripeCreditReversals: Map<string, StripeCreditReversal>;
  aiJobs: Map<string, AiJob>;
  aiStorageCleanups: Map<string, AiStorageCleanup>;
  aiSettings: Map<string, AiSetting>;
  accountDeletionIntents: Map<string, AccountDeletionIntent>;
  aiRemoteJobCleanups: Map<string, AiRemoteJobCleanup>;
  subscriptions: Map<string, Subscription>;
  proCheckoutAttempts: Map<string, ProCheckoutAttempt>;
  topUpCheckoutAttempts: Map<string, TopUpCheckoutAttempt>;
  billingRefundAttempts: Map<string, BillingRefundAttempt>;
  files: Map<string, FileRecord>;
  storageUploads: Map<string, StorageUploadRecord>;
};

// An upload that is still arriving, held while its parts are put in the bucket.
type StorageUploadRecord = {
  id: string;
  userId: string;
  objectKey: string;
  uploadId: string;
  name: string;
  mimeType: string;
  size: bigint;
  partSize: number;
  createdAt: Date;
  completedFileId: string | null;
};

type AggregateSpec = {
  _count?: { _all?: boolean };
  _sum?: Record<string, boolean>;
};

type GroupByArgs = AggregateSpec & {
  by: string[];
  orderBy?: { _sum?: Record<string, "asc" | "desc"> };
  take?: number;
};

function sumField(rows: Record<string, unknown>[], field: string): number {
  return rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
}

function aggregateRows(
  rows: Record<string, unknown>[],
  spec: AggregateSpec,
): { _count: { _all: number }; _sum: Record<string, number> } {
  return {
    _count: { _all: rows.length },
    _sum: Object.fromEntries(
      Object.keys(spec._sum ?? {}).map((field) => [field, sumField(rows, field)]),
    ),
  };
}

// groupBy over an already filtered row set. Prisma returns the grouped columns
// alongside the aggregates, which is what @beutl/db reads.
function groupRows(
  rows: Record<string, unknown>[],
  args: GroupByArgs,
): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const id = JSON.stringify(args.by.map((field) => row[field]));
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }

  let grouped = [...groups.values()].map((groupedRows) => ({
    ...Object.fromEntries(
      args.by.map((field) => [field, groupedRows[0][field]]),
    ),
    ...aggregateRows(groupedRows, args),
  }));

  const sumOrder = args.orderBy?._sum;
  if (sumOrder) {
    const [field, direction] = Object.entries(sumOrder)[0];
    grouped = grouped.sort((left, right) => {
      const difference =
        Number((left._sum as Record<string, number>)[field] ?? 0) -
        Number((right._sum as Record<string, number>)[field] ?? 0);
      return direction === "desc" ? -difference : difference;
    });
  }
  return args.take === undefined ? grouped : grouped.slice(0, args.take);
}

function matchesCreatedAt(
  value: Date,
  filter: { gte?: Date; lt?: Date } | undefined,
): boolean {
  if (!filter) return true;
  if (filter.gte && value.getTime() < filter.gte.getTime()) return false;
  if (filter.lt && value.getTime() >= filter.lt.getTime()) return false;
  return true;
}

type DateFilter = { gt?: Date; gte?: Date; lt?: Date; lte?: Date };

// NULL is outside every range, the way a SQL comparison against it is.
function matchesDateFilter(
  value: Date | null | undefined,
  filter: DateFilter,
): boolean {
  if (value === null || value === undefined) return false;
  const time = value.getTime();
  if (filter.gt && time <= filter.gt.getTime()) return false;
  if (filter.gte && time < filter.gte.getTime()) return false;
  if (filter.lt && time >= filter.lt.getTime()) return false;
  if (filter.lte && time > filter.lte.getTime()) return false;
  return true;
}

export function createInMemoryPrisma() {
  let transactionTail: Promise<void> = Promise.resolve();
  let state: InMemoryPrismaState = {
    billingOffers: new Map(),
    creditAccounts: new Map(),
    aiOperationModels: new Map(),
    creditTransactions: [],
    stripeCreditReversals: new Map(),
    aiJobs: new Map(),
    aiStorageCleanups: new Map(),
    aiSettings: new Map(),
    accountDeletionIntents: new Map(),
    aiRemoteJobCleanups: new Map(),
    subscriptions: new Map(),
    proCheckoutAttempts: new Map(),
    topUpCheckoutAttempts: new Map(),
    billingRefundAttempts: new Map(),
    files: new Map(),
    storageUploads: new Map(),
  };

  const now = () => new Date();
  const reversalKey = (kind: string, id: string) => `${kind}:${id}`;
  type AiJobWhere = {
    id?: string;
    userId?: string;
    kind?: string;
    provider?: string;
    providerJobId?: string | null;
    idempotencyKeyHash?: string | null;
    callbackNonceHash?: string | null;
    status?: string | { in?: string[]; notIn?: string[] };
    updatedAt?: Date | { lte: Date };
    deletedAt?: null | { not: null };
    providerPollLeaseExpiresAt?: Date | null | { lte: Date };
    finalizationToken?: string | null;
    finalizationLeaseExpiresAt?: null | { lte: Date };
    resultFileId?: string | null | { not: null };
    OR?: AiJobWhere[];
    AND?: AiJobWhere[];
  };
  const matchesAiJobWhere = (job: AiJob, where: AiJobWhere): boolean => {
    const statusMatches =
      !where.status ||
      (typeof where.status === "string"
        ? job.status === where.status
        : (!where.status.in || where.status.in.includes(job.status)) &&
          (!where.status.notIn || !where.status.notIn.includes(job.status)));
    const updatedAtMatches =
      !where.updatedAt ||
      (where.updatedAt instanceof Date
        ? job.updatedAt.getTime() === where.updatedAt.getTime()
        : job.updatedAt.getTime() <= where.updatedAt.lte.getTime());
    const deletedAtMatches =
      where.deletedAt === undefined ||
      (where.deletedAt === null
        ? job.deletedAt === null
        : job.deletedAt !== null);
    const leaseMatches =
      where.finalizationLeaseExpiresAt === undefined ||
      (where.finalizationLeaseExpiresAt === null
        ? job.finalizationLeaseExpiresAt === null
        : job.finalizationLeaseExpiresAt !== null &&
          job.finalizationLeaseExpiresAt.getTime() <=
            where.finalizationLeaseExpiresAt.lte.getTime());
    const providerPollLeaseMatches =
      where.providerPollLeaseExpiresAt === undefined ||
      (where.providerPollLeaseExpiresAt === null
        ? job.providerPollLeaseExpiresAt === null
        : where.providerPollLeaseExpiresAt instanceof Date
          ? job.providerPollLeaseExpiresAt?.getTime() ===
            where.providerPollLeaseExpiresAt.getTime()
          : job.providerPollLeaseExpiresAt !== null &&
            job.providerPollLeaseExpiresAt.getTime() <=
              where.providerPollLeaseExpiresAt.lte.getTime());
    return (
      (!where.id || job.id === where.id) &&
      (!where.userId || job.userId === where.userId) &&
      (!where.kind || job.kind === where.kind) &&
      (!where.provider || job.provider === where.provider) &&
      (where.providerJobId === undefined ||
        job.providerJobId === where.providerJobId) &&
      statusMatches &&
      updatedAtMatches &&
      deletedAtMatches &&
      (where.finalizationToken === undefined ||
        job.finalizationToken === where.finalizationToken) &&
      (where.idempotencyKeyHash === undefined ||
        job.idempotencyKeyHash === where.idempotencyKeyHash) &&
      (where.callbackNonceHash === undefined ||
        job.callbackNonceHash === where.callbackNonceHash) &&
      (where.resultFileId === undefined ||
        (typeof where.resultFileId === "object"
          ? job.resultFileId !== null
          : job.resultFileId === where.resultFileId)) &&
      providerPollLeaseMatches &&
      leaseMatches &&
      (!where.AND || where.AND.every((condition) =>
        matchesAiJobWhere(job, condition))) &&
      (!where.OR || where.OR.some((condition) =>
        matchesAiJobWhere(job, condition)))
    );
  };
  type TopUpCheckoutAttemptWhere = {
    id?: string;
    ownerUserId?: string;
    status?: string | { in?: string[]; notIn?: string[]; not?: string };
    stripeCheckoutSessionId?: string | null;
    stripePaymentIntentId?: string | null;
    refundId?: string | null;
    refundLeaseToken?: string | null;
    refundNotBefore?: null | { lte: Date };
    refundLeaseExpiresAt?: null | { lte: Date };
    refundInterventionAt?: null;
    accountDeletionAt?: null | { not: null };
    updatedAt?: Date;
    OR?: TopUpCheckoutAttemptWhere[];
    AND?: TopUpCheckoutAttemptWhere[];
  };
  const matchesTopUpCheckoutAttemptWhere = (
    attempt: TopUpCheckoutAttempt,
    where: TopUpCheckoutAttemptWhere,
  ): boolean => {
    const statusMatches =
      where.status === undefined ||
      (typeof where.status === "string"
        ? attempt.status === where.status
        : (!where.status.in || where.status.in.includes(attempt.status)) &&
          (!where.status.notIn ||
            !where.status.notIn.includes(attempt.status)) &&
          (!where.status.not || attempt.status !== where.status.not));
    const notBeforeMatches =
      where.refundNotBefore === undefined ||
      (where.refundNotBefore === null
        ? attempt.refundNotBefore === null
        : attempt.refundNotBefore !== null &&
          attempt.refundNotBefore.getTime() <=
            where.refundNotBefore.lte.getTime());
    const leaseExpiresAtMatches =
      where.refundLeaseExpiresAt === undefined ||
      (where.refundLeaseExpiresAt === null
        ? attempt.refundLeaseExpiresAt === null
        : attempt.refundLeaseExpiresAt !== null &&
          attempt.refundLeaseExpiresAt.getTime() <=
            where.refundLeaseExpiresAt.lte.getTime());
    const deletionMatches =
      where.accountDeletionAt === undefined ||
      (where.accountDeletionAt === null
        ? attempt.accountDeletionAt === null
        : attempt.accountDeletionAt !== null);
    return (
      (where.id === undefined || attempt.id === where.id) &&
      (where.ownerUserId === undefined ||
        attempt.ownerUserId === where.ownerUserId) &&
      statusMatches &&
      (where.stripeCheckoutSessionId === undefined ||
        attempt.stripeCheckoutSessionId === where.stripeCheckoutSessionId) &&
      (where.stripePaymentIntentId === undefined ||
        attempt.stripePaymentIntentId === where.stripePaymentIntentId) &&
      (where.refundId === undefined || attempt.refundId === where.refundId) &&
      (where.refundLeaseToken === undefined ||
        attempt.refundLeaseToken === where.refundLeaseToken) &&
      notBeforeMatches &&
      leaseExpiresAtMatches &&
      (where.refundInterventionAt === undefined ||
        attempt.refundInterventionAt === null) &&
      deletionMatches &&
      (where.updatedAt === undefined ||
        attempt.updatedAt.getTime() === where.updatedAt.getTime()) &&
      (!where.AND ||
        where.AND.every((condition) =>
          matchesTopUpCheckoutAttemptWhere(attempt, condition))) &&
      (!where.OR ||
        where.OR.some((condition) =>
          matchesTopUpCheckoutAttemptWhere(attempt, condition)))
    );
  };
  type BillingRefundAttemptWhere = {
    id?: string;
    sourceKey?: string;
    stripePaymentIntentId?: string | null;
    status?: string | { in?: string[] };
    leaseToken?: string | null;
    notBefore?: null | { lte: Date };
    leaseExpiresAt?: null | { lte: Date };
    interventionAt?: null;
    updatedAt?: Date;
    OR?: BillingRefundAttemptWhere[];
    AND?: BillingRefundAttemptWhere[];
  };
  const matchesBillingRefundAttemptWhere = (
    attempt: BillingRefundAttempt,
    where: BillingRefundAttemptWhere,
  ): boolean => {
    const statusMatches = where.status === undefined ||
      (typeof where.status === "string"
        ? attempt.status === where.status
        : !where.status.in || where.status.in.includes(attempt.status));
    const notBeforeMatches = where.notBefore === undefined ||
      (where.notBefore === null
        ? attempt.notBefore === null
        : attempt.notBefore !== null &&
          attempt.notBefore.getTime() <= where.notBefore.lte.getTime());
    const leaseExpiresAtMatches = where.leaseExpiresAt === undefined ||
      (where.leaseExpiresAt === null
        ? attempt.leaseExpiresAt === null
        : attempt.leaseExpiresAt !== null &&
          attempt.leaseExpiresAt.getTime() <= where.leaseExpiresAt.lte.getTime());
    return (
      (where.id === undefined || attempt.id === where.id) &&
      (where.sourceKey === undefined || attempt.sourceKey === where.sourceKey) &&
      (where.stripePaymentIntentId === undefined ||
        attempt.stripePaymentIntentId === where.stripePaymentIntentId) &&
      statusMatches &&
      (where.leaseToken === undefined || attempt.leaseToken === where.leaseToken) &&
      notBeforeMatches &&
      leaseExpiresAtMatches &&
      (where.interventionAt === undefined || attempt.interventionAt === null) &&
      (where.updatedAt === undefined ||
        attempt.updatedAt.getTime() === where.updatedAt.getTime()) &&
      (!where.AND || where.AND.every((item) =>
        matchesBillingRefundAttemptWhere(attempt, item))) &&
      (!where.OR || where.OR.some((item) =>
        matchesBillingRefundAttemptWhere(attempt, item)))
    );
  };
  const aiJobResultForFile = (fileId: string) =>
    [...state.aiJobs.values()].find((job) => job.resultFileId === fileId);
  const projectSelectedFields = (
    record: Record<string, unknown>,
    selection: unknown,
  ): Record<string, unknown> => {
    if (
      typeof selection !== "object" ||
      selection === null ||
      !("select" in selection) ||
      typeof selection.select !== "object" ||
      selection.select === null
    ) {
      return { ...record };
    }
    return Object.fromEntries(
      Object.entries(selection.select as Record<string, unknown>)
        .filter(([, selected]) => selected === true)
        .map(([key]) => [key, record[key]]),
    );
  };
  const aiJobWithResultFile = (
    job: AiJob,
    include?: { resultFile?: unknown },
    select?: Record<string, unknown>,
  ): Record<string, unknown> => {
    const selectedJob = select
      ? Object.fromEntries(
          Object.entries(select)
            .filter(([key, selected]) => key !== "resultFile" && selected === true)
            .map(([key]) => [key, job[key as keyof AiJob]]),
        )
      : { ...job };
    const resultFileSelection = include?.resultFile ?? select?.resultFile;
    if (resultFileSelection !== undefined) {
      const resultFile = job.resultFileId
        ? state.files.get(job.resultFileId) ?? null
        : null;
      selectedJob.resultFile = resultFile
        ? projectSelectedFields(
            resultFile as unknown as Record<string, unknown>,
            resultFileSelection,
          )
        : null;
    }
    return selectedJob;
  };

  // Snapshot state for $transaction rollback so contract tests reproduce the
  // discard-on-failure behavior of the real database.
  const snapshot = () => ({
    // Every table the state carries, so a rolled-back transaction leaves none
    // of them holding what the aborted callback wrote. An omission here is
    // invisible until a test asserts that a failure changed nothing.
    billingOffers: new Map(
      [...state.billingOffers].map(([k, v]) => [k, { ...v }]),
    ),
    creditAccounts: new Map(
      [...state.creditAccounts].map(([k, v]) => [k, { ...v }]),
    ),
    creditTransactions: state.creditTransactions.map((t) => ({ ...t })),
    stripeCreditReversals: new Map(
      [...state.stripeCreditReversals].map(([k, v]) => [k, { ...v }]),
    ),
    aiJobs: new Map([...state.aiJobs].map(([k, v]) => [k, { ...v }])),
    aiStorageCleanups: new Map(
      [...state.aiStorageCleanups].map(([k, v]) => [k, { ...v }]),
    ),
    aiSettings: new Map([...state.aiSettings].map(([k, v]) => [k, { ...v }])),
    aiOperationModels: new Map(
      [...state.aiOperationModels].map(([k, v]) => [k, { ...v }]),
    ),
    accountDeletionIntents: new Map(
      [...state.accountDeletionIntents].map(([k, v]) => [k, { ...v }]),
    ),
    aiRemoteJobCleanups: new Map(
      [...state.aiRemoteJobCleanups].map(([k, v]) => [k, { ...v }]),
    ),
    subscriptions: new Map(
      [...state.subscriptions].map(([k, v]) => [k, { ...v }]),
    ),
    proCheckoutAttempts: new Map(
      [...state.proCheckoutAttempts].map(([k, v]) => [k, { ...v }]),
    ),
    topUpCheckoutAttempts: new Map(
      [...state.topUpCheckoutAttempts].map(([k, v]) => [k, { ...v }]),
    ),
    billingRefundAttempts: new Map(
      [...state.billingRefundAttempts].map(([k, v]) => [k, { ...v }]),
    ),
    files: new Map([...state.files].map(([k, v]) => [k, { ...v }])),
    storageUploads: new Map(
      [...state.storageUploads].map(([k, v]) => [k, { ...v }]),
    ),
  });

  const restore = (s: ReturnType<typeof snapshot>) => {
    Object.assign(state, s);
  };

  const prisma = {
    accountDeletionIntent: {
      findFirst: async ({
        where,
      }: {
        where: { userId?: string; expiresAt?: { gt: Date } };
      }) => {
        const intent = [...state.accountDeletionIntents.values()].find(
          (item) =>
            (!where.userId || item.userId === where.userId) &&
            (!where.expiresAt ||
              item.expiresAt.getTime() > where.expiresAt.gt.getTime()),
        );
        return intent ? { ...intent } : null;
      },
    },
    creditAccount: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { userId: string };
        create: {
          userId: string;
          usagePeriodStart?: Date | null;
          usagePeriodEnd?: Date | null;
        };
        update: Partial<CreditAccount>;
      }) => {
        const existing = state.creditAccounts.get(where.userId);
        if (existing) {
          return { ...existing, ...update };
        }
        const account: CreditAccount = {
          userId: create.userId,
          monthlyUsageUsed: 0,
          usagePeriodStart: create.usagePeriodStart ?? null,
          usagePeriodEnd: create.usagePeriodEnd ?? null,
          purchasedCredits: 0,
          purchasedCreditDebt: 0,
          createdAt: now(),
          updatedAt: now(),
        };
        state.creditAccounts.set(account.userId, account);
        return { ...account };
      },
      update: async ({
        where,
        data,
      }: {
        where: { userId: string };
        data: Partial<
          Pick<
            CreditAccount,
            | "monthlyUsageUsed"
            | "usagePeriodStart"
            | "usagePeriodEnd"
            | "purchasedCredits"
            | "purchasedCreditDebt"
          >
        >;
      }) => {
        const existing = state.creditAccounts.get(where.userId);
        if (!existing) {
          throw new Error("CreditAccount not found");
        }
        const updated: CreditAccount = {
          ...existing,
          ...data,
          updatedAt: now(),
        };
        state.creditAccounts.set(where.userId, updated);
        return { ...updated };
      },
      findUnique: async ({ where }: { where: { userId: string } }) => {
        const account = state.creditAccounts.get(where.userId);
        return account ? { ...account } : null;
      },
      findMany: async ({
        take,
      }: {
        select?: Record<string, boolean>;
        orderBy?: { userId?: "asc" | "desc" };
        take?: number;
      } = {}) => {
        const rows = [...state.creditAccounts.values()].sort((left, right) =>
          left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0,
        );
        return (take === undefined ? rows : rows.slice(0, take)).map((row) => ({
          ...row,
        }));
      },
      aggregate: async (
        spec: AggregateSpec & { where?: Record<string, unknown> },
      ) => {
        const rows = [...state.creditAccounts.values()] as unknown as Record<
          string,
          unknown
        >[];
        const where = spec.where ?? {};
        // Dropping a filter this stub does not model would leave the aggregate
        // quietly answering a broader question than the caller asked, and the
        // test would pass on a total the database would never return.
        for (const key of Object.keys(where)) {
          if (key !== "usagePeriodEnd") {
            throw new Error(
              `in-memory creditAccount.aggregate does not model where.${key}`,
            );
          }
        }
        const filtered = where.usagePeriodEnd
          ? rows.filter((row) =>
              matchesDateFilter(
                row.usagePeriodEnd as Date | null,
                where.usagePeriodEnd as DateFilter,
              ),
            )
          : rows;
        return aggregateRows(filtered, spec);
      },
    },
    creditTransaction: {
      create: async ({
        data,
      }: {
        data: {
          userId: string;
          creditAmount: number;
          debtAmount?: number;
          usageAmount?: number;
          usagePeriodStart?: Date | null;
          usagePeriodEnd?: Date | null;
          kind: string;
          aiJobId?: string;
          stripePaymentId?: string;
          stripePaymentAmount?: number;
          stripeCurrency?: string;
          stripeSourcePaymentId?: string;
          stripeReversalKind?: string;
          stripeReversalId?: string;
          stripeReversalRevision?: number;
          adminAdjustmentKey?: string;
        };
      }) => {
        if (
          data.stripePaymentId &&
          state.creditTransactions.some(
            (t) => t.stripePaymentId === data.stripePaymentId,
          )
        ) {
          throw Object.assign(new Error("Unique constraint failed on stripePaymentId"), {
            code: "P2002",
          });
        }
        if (
          data.stripeReversalKind &&
          data.stripeReversalId &&
          data.stripeReversalRevision !== undefined &&
          state.creditTransactions.some(
            (transaction) =>
              transaction.stripeReversalKind === data.stripeReversalKind &&
              transaction.stripeReversalId === data.stripeReversalId &&
              transaction.stripeReversalRevision ===
                data.stripeReversalRevision,
          )
        ) {
          throw Object.assign(new Error("Unique constraint failed on Stripe reversal revision"), {
            code: "P2002",
          });
        }
        if (
          data.aiJobId &&
          state.creditTransactions.some(
            (transaction) =>
              transaction.aiJobId === data.aiJobId &&
              transaction.kind === data.kind,
          )
        ) {
          throw Object.assign(new Error("Unique constraint failed on aiJobId and kind"), {
            code: "P2002",
          });
        }
        if (
          data.adminAdjustmentKey &&
          state.creditTransactions.some(
            (transaction) =>
              transaction.adminAdjustmentKey === data.adminAdjustmentKey,
          )
        ) {
          throw Object.assign(new Error("Unique constraint failed on adminAdjustmentKey"), {
            code: "P2002",
          });
        }
        const transaction: CreditTransaction = {
          id: crypto.randomUUID(),
          userId: data.userId,
          creditAmount: data.creditAmount,
          debtAmount: data.debtAmount ?? 0,
          usageAmount: data.usageAmount ?? 0,
          usagePeriodStart: data.usagePeriodStart ?? null,
          usagePeriodEnd: data.usagePeriodEnd ?? null,
          kind: data.kind,
          aiJobId: data.aiJobId ?? null,
          stripePaymentId: data.stripePaymentId ?? null,
          stripePaymentAmount: data.stripePaymentAmount ?? null,
          stripeCurrency: data.stripeCurrency ?? null,
          stripeSourcePaymentId: data.stripeSourcePaymentId ?? null,
          stripeReversalKind: data.stripeReversalKind ?? null,
          stripeReversalId: data.stripeReversalId ?? null,
          stripeReversalRevision: data.stripeReversalRevision ?? null,
          adminAdjustmentKey: data.adminAdjustmentKey ?? null,
          createdAt: now(),
        };
        state.creditTransactions.push(transaction);
        return { ...transaction };
      },
      findMany: async ({
        where,
        orderBy,
      }: {
        where: {
          userId?: string;
          kind?: string;
          stripeSourcePaymentId?: string;
          stripePaymentId?: { not: null };
          createdAt?: { gte?: Date; lt?: Date };
        };
        orderBy?: { createdAt: "asc" | "desc" };
      }) => {
        const items = state.creditTransactions.filter(
          (transaction) =>
            (!where.userId || transaction.userId === where.userId) &&
            (!where.kind || transaction.kind === where.kind) &&
            matchesCreatedAt(transaction.createdAt, where.createdAt) &&
            (!where.stripePaymentId ||
              (transaction.stripePaymentId !== null &&
                transaction.stripePaymentId !== undefined)) &&
            (!where.stripeSourcePaymentId ||
              transaction.stripeSourcePaymentId ===
                where.stripeSourcePaymentId),
        );
        if (orderBy?.createdAt === "desc") {
          items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return items.map((t) => ({ ...t }));
      },
      groupBy: async ({
        where,
        ...args
      }: GroupByArgs & {
        where?: { kind?: string; createdAt?: { gte?: Date; lt?: Date } };
      }) => {
        const rows = state.creditTransactions.filter(
          (transaction) =>
            (!where?.kind || transaction.kind === where.kind) &&
            matchesCreatedAt(transaction.createdAt, where?.createdAt),
        );
        return groupRows(rows as unknown as Record<string, unknown>[], args);
      },
      findUnique: async ({
        where,
      }: {
        where:
          | { stripePaymentId: string }
          | { adminAdjustmentKey: string }
          | {
              stripeReversalKind_stripeReversalId_stripeReversalRevision: {
                stripeReversalKind: string;
                stripeReversalId: string;
                stripeReversalRevision: number;
              };
            };
      }) => {
        const item =
          "stripePaymentId" in where
            ? state.creditTransactions.find(
                (transaction) =>
                  transaction.stripePaymentId === where.stripePaymentId,
              )
            : "adminAdjustmentKey" in where
            ? state.creditTransactions.find(
                (transaction) =>
                  transaction.adminAdjustmentKey === where.adminAdjustmentKey,
              )
            : state.creditTransactions.find(
                (transaction) =>
                  transaction.stripeReversalKind ===
                    where
                      .stripeReversalKind_stripeReversalId_stripeReversalRevision
                      .stripeReversalKind &&
                  transaction.stripeReversalId ===
                    where
                      .stripeReversalKind_stripeReversalId_stripeReversalRevision
                      .stripeReversalId &&
                  transaction.stripeReversalRevision ===
                    where
                      .stripeReversalKind_stripeReversalId_stripeReversalRevision
                      .stripeReversalRevision,
              );
        return item ? { ...item } : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<
          Pick<
            CreditTransaction,
            | "stripePaymentAmount"
            | "stripeCurrency"
            | "stripeSourcePaymentId"
          >
        >;
      }) => {
        const index = state.creditTransactions.findIndex(
          (transaction) => transaction.id === where.id,
        );
        if (index < 0) {
          throw new Error("CreditTransaction not found");
        }
        const updated = { ...state.creditTransactions[index], ...data };
        state.creditTransactions[index] = updated;
        return { ...updated };
      },
      findFirst: async ({
        where,
      }: {
        where: { userId?: string; aiJobId?: string; kind?: string };
      }) => {
        const item = state.creditTransactions.find(
          (transaction) =>
            (!where.userId || transaction.userId === where.userId) &&
            (!where.aiJobId || transaction.aiJobId === where.aiJobId) &&
            (!where.kind || transaction.kind === where.kind),
        );
        return item ? { ...item } : null;
      },
    },
    stripeCreditReversal: {
      findUnique: async ({
        where,
      }: {
        where: {
          stripeReversalKind_stripeReversalId: {
            stripeReversalKind: string;
            stripeReversalId: string;
          };
        };
      }) => {
        const key = reversalKey(
          where.stripeReversalKind_stripeReversalId.stripeReversalKind,
          where.stripeReversalKind_stripeReversalId.stripeReversalId,
        );
        const reversal = state.stripeCreditReversals.get(key);
        return reversal ? { ...reversal } : null;
      },
      findMany: async ({
        where,
      }: {
        where: { stripePaymentId: string };
      }) =>
        [...state.stripeCreditReversals.values()]
          .filter(
            (reversal) =>
              reversal.stripePaymentId === where.stripePaymentId,
          )
          .map((reversal) => ({ ...reversal })),
      create: async ({
        data,
      }: {
        data: {
          stripePaymentId: string;
          stripeReversalKind: string;
          stripeReversalId: string;
          stripeAmount: number;
          stripeCurrency: string;
          status: string;
          active: boolean;
          progressionRank?: number;
          stripeEventId?: string;
          stripeEventCreatedAt?: Date;
        };
      }) => {
        const key = reversalKey(
          data.stripeReversalKind,
          data.stripeReversalId,
        );
        if (state.stripeCreditReversals.has(key)) {
          throw Object.assign(new Error("Unique constraint failed on Stripe reversal"), {
            code: "P2002",
          });
        }
        const timestamp = now();
        const reversal: StripeCreditReversal = {
          id: crypto.randomUUID(),
          ...data,
          progressionRank: data.progressionRank ?? 0,
          stripeEventId: data.stripeEventId ?? null,
          stripeEventCreatedAt: data.stripeEventCreatedAt ?? null,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        state.stripeCreditReversals.set(key, reversal);
        return { ...reversal };
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: {
          stripeReversalKind_stripeReversalId: {
            stripeReversalKind: string;
            stripeReversalId: string;
          };
        };
        create: {
          stripePaymentId: string;
          stripeReversalKind: string;
          stripeReversalId: string;
          stripeAmount: number;
          stripeCurrency: string;
          status: string;
          active: boolean;
          progressionRank: number;
          stripeEventId: string;
          stripeEventCreatedAt: Date;
        };
        update: Partial<StripeCreditReversal>;
      }) => {
        const key = reversalKey(
          where.stripeReversalKind_stripeReversalId.stripeReversalKind,
          where.stripeReversalKind_stripeReversalId.stripeReversalId,
        );
        const existing = state.stripeCreditReversals.get(key);
        if (existing) {
          const updated = { ...existing, ...update, updatedAt: now() };
          state.stripeCreditReversals.set(key, updated);
          return { ...updated };
        }
        const timestamp = now();
        const reversal: StripeCreditReversal = {
          id: crypto.randomUUID(),
          ...create,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        state.stripeCreditReversals.set(key, reversal);
        return { ...reversal };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          id: string;
          revision: number;
          progressionRank: number;
          stripeEventId: string | null;
          stripeEventCreatedAt: Date | null;
        };
        data: Partial<StripeCreditReversal>;
      }) => {
        const entry = [...state.stripeCreditReversals.entries()].find(
          ([, reversal]) => reversal.id === where.id,
        );
        if (!entry) return { count: 0 };
        const [key, existing] = entry;
        const eventCreatedMatches =
          existing.stripeEventCreatedAt?.getTime() ===
          where.stripeEventCreatedAt?.getTime();
        if (
          existing.revision !== where.revision ||
          existing.progressionRank !== where.progressionRank ||
          existing.stripeEventId !== where.stripeEventId ||
          !eventCreatedMatches
        ) {
          return { count: 0 };
        }
        state.stripeCreditReversals.set(key, {
          ...existing,
          ...data,
          updatedAt: now(),
        });
        return { count: 1 };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<
          Pick<
            StripeCreditReversal,
            | "stripeAmount"
            | "stripeCurrency"
            | "status"
            | "active"
            | "revision"
          >
        >;
      }) => {
        const existing = [...state.stripeCreditReversals.values()].find(
          (reversal) => reversal.id === where.id,
        );
        if (!existing) {
          throw new Error("StripeCreditReversal not found");
        }
        const updated = { ...existing, ...data, updatedAt: now() };
        state.stripeCreditReversals.set(
          reversalKey(
            updated.stripeReversalKind,
            updated.stripeReversalId,
          ),
          updated,
        );
        return { ...updated };
      },
    },
    aiJob: {
      groupBy: async ({
        where,
        ...args
      }: GroupByArgs & {
        where?: { createdAt?: { gte?: Date; lt?: Date }; status?: string };
      }) => {
        const rows = [...state.aiJobs.values()].filter(
          (job) =>
            (!where?.status || job.status === where.status) &&
            matchesCreatedAt(job.createdAt, where?.createdAt),
        );
        return groupRows(rows as unknown as Record<string, unknown>[], args);
      },
      create: async ({
        data,
      }: {
        data: {
          userId: string;
          kind: string;
          provider: string;
          providerJobId?: string;
          idempotencyKeyHash?: string;
          requestFingerprint?: string;
          callbackNonceHash?: string;
          status: string;
          inputParams?: object;
          model?: string;
          usageUnits: number;
        };
      }) => {
        if (
          data.idempotencyKeyHash &&
          [...state.aiJobs.values()].some(
            (job) =>
              job.userId === data.userId &&
              job.idempotencyKeyHash === data.idempotencyKeyHash,
          )
        ) {
          throw Object.assign(
            new Error("Unique constraint failed on userId and idempotencyKeyHash"),
            { code: "P2002" },
          );
        }
        if (
          data.providerJobId &&
          [...state.aiJobs.values()].some(
            (job) =>
              job.provider === data.provider &&
              job.providerJobId === data.providerJobId,
          )
        ) {
          throw Object.assign(
            new Error("Unique constraint failed on provider and providerJobId"),
            { code: "P2002" },
          );
        }
        const job: AiJob = {
          id: crypto.randomUUID(),
          userId: data.userId,
          kind: data.kind,
          provider: data.provider,
          providerJobId: data.providerJobId ?? null,
          idempotencyKeyHash: data.idempotencyKeyHash ?? null,
          requestFingerprint: data.requestFingerprint ?? null,
          callbackNonceHash: data.callbackNonceHash ?? null,
          status: data.status,
          inputParams: data.inputParams ?? null,
          model: data.model ?? null,
          resultFileId: null,
          usageUnits: data.usageUnits,
          error: null,
          providerPollLeaseExpiresAt: null,
          finalizationToken: null,
          finalizationLeaseExpiresAt: null,
          deletedAt: null,
          createdAt: now(),
          updatedAt: now(),
        };
        state.aiJobs.set(job.id, job);
        return { ...job };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: {
          status?: string;
          resultFileId?: string | null;
          error?: string | null;
          providerJobId?: string | null;
          inputParams?: unknown;
          deletedAt?: Date | null;
          providerPollLeaseExpiresAt?: Date | null;
          finalizationToken?: string | null;
          finalizationLeaseExpiresAt?: Date | null;
        };
      }) => {
        const existing = state.aiJobs.get(where.id);
        if (!existing) {
          throw new Error("AiJob not found");
        }
        const updated: AiJob = {
          ...existing,
          ...data,
          updatedAt: now(),
        };
        state.aiJobs.set(where.id, updated);
        return { ...updated };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: AiJobWhere;
        data: Partial<
          Pick<
            AiJob,
            | "status"
            | "resultFileId"
            | "error"
            | "providerJobId"
            | "idempotencyKeyHash"
            | "requestFingerprint"
            | "callbackNonceHash"
            | "inputParams"
            | "deletedAt"
            | "providerPollLeaseExpiresAt"
            | "finalizationToken"
            | "finalizationLeaseExpiresAt"
          >
        >;
      }) => {
        let count = 0;
        for (const [id, job] of state.aiJobs) {
          if (matchesAiJobWhere(job, where)) {
            if (
              data.providerJobId &&
              [...state.aiJobs.values()].some(
                (candidate) =>
                  candidate.id !== id &&
                  candidate.provider === job.provider &&
                  candidate.providerJobId === data.providerJobId,
              )
            ) {
              throw Object.assign(
                new Error("Unique constraint failed on provider and providerJobId"),
                { code: "P2002" },
              );
            }
            state.aiJobs.set(id, {
              ...job,
              ...data,
              inputParams:
                "inputParams" in data ? null : job.inputParams,
              updatedAt: now(),
            });
            count++;
          }
        }
        return { count };
      },
      findUnique: async ({
        where,
        include,
        select,
      }: {
        where:
          | { id: string }
          | {
              userId_idempotencyKeyHash: {
                userId: string;
                idempotencyKeyHash: string;
              };
            }
          | {
              provider_providerJobId: {
                provider: string;
                providerJobId: string;
              };
            };
        include?: { resultFile?: unknown };
        select?: Record<string, unknown>;
      }) => {
        const job = "id" in where
          ? state.aiJobs.get(where.id)
          : "userId_idempotencyKeyHash" in where
            ? [...state.aiJobs.values()].find(
                (candidate) =>
                  candidate.userId === where.userId_idempotencyKeyHash.userId &&
                  candidate.idempotencyKeyHash ===
                    where.userId_idempotencyKeyHash.idempotencyKeyHash,
              )
            : [...state.aiJobs.values()].find(
                (candidate) =>
                  candidate.provider === where.provider_providerJobId.provider &&
                  candidate.providerJobId ===
                    where.provider_providerJobId.providerJobId,
              );
        return job ? aiJobWithResultFile(job, include, select) : null;
      },
      findFirst: async ({
        where,
        include,
        select,
      }: {
        where: AiJobWhere;
        include?: { resultFile?: unknown };
        select?: Record<string, unknown>;
      }) => {
        const job = [...state.aiJobs.values()].find(
          (item) => matchesAiJobWhere(item, where),
        );
        return job ? aiJobWithResultFile(job, include, select) : null;
      },
      count: async ({
        where,
      }: {
        where?: {
          userId?: string;
          kind?: string;
          status?: { in?: string[] };
          deletedAt?: null;
        };
      }) => {
        let jobs = [...state.aiJobs.values()];
        if (where?.userId) {
          jobs = jobs.filter((j) => j.userId === where.userId);
        }
        if (where?.kind) {
          jobs = jobs.filter((j) => j.kind === where.kind);
        }
        if (where?.status?.in) {
          jobs = jobs.filter((j) => where.status!.in!.includes(j.status));
        }
        if (where?.deletedAt === null) {
          jobs = jobs.filter((job) => job.deletedAt === null);
        }
        return jobs.length;
      },
      findMany: async ({
        where,
        orderBy,
        take,
        include,
      }: {
        where?: {
          userId?: string;
          deletedAt?: null;
          status?: { in: string[] };
          updatedAt?: { lte: Date };
          OR?: Array<{
            createdAt?: Date | { lt: Date };
            id?: { lt: string };
          }>;
        };
        orderBy?:
          | { updatedAt: "asc" | "desc" }
          | Array<
              | { createdAt: "asc" | "desc" }
              | { id: "asc" | "desc" }
            >;
        take?: number;
        include?: { resultFile?: unknown };
      }) => {
        let jobs = [...state.aiJobs.values()];
        if (where?.userId) {
          jobs = jobs.filter((job) => job.userId === where.userId);
        }
        if (where?.deletedAt === null) {
          jobs = jobs.filter((job) => job.deletedAt === null);
        }
        if (where?.status) {
          jobs = jobs.filter((job) => where.status!.in.includes(job.status));
        }
        if (where?.updatedAt) {
          jobs = jobs.filter(
            (job) =>
              job.updatedAt.getTime() <= where.updatedAt!.lte.getTime(),
          );
        }
        if (where?.OR) {
          jobs = jobs.filter((job) =>
            where.OR!.some((condition) => {
              const createdAtMatches =
                condition.createdAt === undefined ||
                (condition.createdAt instanceof Date
                  ? job.createdAt.getTime() === condition.createdAt.getTime()
                  : job.createdAt.getTime() <
                    condition.createdAt.lt.getTime());
              const idMatches =
                condition.id === undefined || job.id < condition.id.lt;
              return createdAtMatches && idMatches;
            }),
          );
        }
        if (Array.isArray(orderBy)) {
          jobs.sort((left, right) => {
            for (const ordering of orderBy) {
              if ("createdAt" in ordering) {
                const direction = ordering.createdAt === "asc" ? 1 : -1;
                const difference =
                  left.createdAt.getTime() - right.createdAt.getTime();
                if (difference !== 0) return direction * difference;
              } else {
                const direction = ordering.id === "asc" ? 1 : -1;
                const difference =
                  left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
                if (difference !== 0) return direction * difference;
              }
            }
            return 0;
          });
        } else if (orderBy?.updatedAt) {
          const direction = orderBy.updatedAt === "asc" ? 1 : -1;
          jobs.sort(
            (left, right) =>
              direction *
              (left.updatedAt.getTime() - right.updatedAt.getTime()),
          );
        }
        const page = take === undefined ? jobs : jobs.slice(0, take);
        return page.map((job) => aiJobWithResultFile(job, include));
      },
    },
    subscription: {
      count: async ({
        where,
      }: {
        where?: { status?: string; currentPeriodEnd?: { gt?: Date } };
      } = {}) =>
        [...state.subscriptions.values()].filter(
          (subscription) =>
            (!where?.status || subscription.status === where.status) &&
            (!where?.currentPeriodEnd?.gt ||
              (subscription.currentPeriodEnd !== null &&
                subscription.currentPeriodEnd.getTime() >
                  where.currentPeriodEnd.gt.getTime())),
        ).length,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { userId: string };
        create: {
          userId: string;
          stripeSubscriptionId: string;
          status: string;
          planId: string;
          billingOfferId?: string | null;
          currentPeriodStart?: Date | null;
          currentPeriodEnd?: Date | null;
          cancelAtPeriodEnd?: boolean;
          cancelAt?: Date | null;
          stripeEventId?: string | null;
          stripeEventCreatedAt?: Date | null;
          stripeCanonicalObservedAt?: Date | null;
          stripeObservationRank?: string | null;
        };
        update: Partial<{
          stripeSubscriptionId: string;
          status: string;
          planId: string;
          billingOfferId?: string | null;
          currentPeriodStart?: Date | null;
          currentPeriodEnd?: Date | null;
          cancelAtPeriodEnd?: boolean;
          cancelAt?: Date | null;
          stripeEventId?: string | null;
          stripeEventCreatedAt?: Date | null;
          stripeCanonicalObservedAt?: Date | null;
          stripeObservationRank?: string | null;
        }>;
      }) => {
        const existing = state.subscriptions.get(where.userId);
        const base: Subscription = existing ?? {
          userId: create.userId,
          stripeSubscriptionId: create.stripeSubscriptionId,
          status: create.status,
          planId: create.planId,
          billingOfferId: create.billingOfferId ?? null,
          currentPeriodStart: create.currentPeriodStart ?? null,
          currentPeriodEnd: create.currentPeriodEnd ?? null,
          cancelAtPeriodEnd: create.cancelAtPeriodEnd ?? false,
          cancelAt: create.cancelAt ?? null,
          stripeEventId: create.stripeEventId ?? null,
          stripeEventCreatedAt: create.stripeEventCreatedAt ?? null,
          stripeCanonicalObservedAt:
            create.stripeCanonicalObservedAt ?? null,
          stripeObservationRank: create.stripeObservationRank ?? null,
          createdAt: now(),
          updatedAt: now(),
        };
        const record: Subscription = {
          ...base,
          ...update,
          updatedAt: now(),
        };
        state.subscriptions.set(where.userId, record);
        return { ...record };
      },
      findUnique: async ({ where }: { where: { userId: string } }) => {
        const record = state.subscriptions.get(where.userId);
        return record ? { ...record } : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { userId: string };
        data: {
          status: string;
          currentPeriodStart?: Date | null;
          currentPeriodEnd?: Date | null;
        };
      }) => {
        const existing = state.subscriptions.get(where.userId);
        if (!existing) {
          throw new Error("Subscription not found");
        }
        const updated: Subscription = {
          ...existing,
          ...data,
          updatedAt: now(),
        };
        state.subscriptions.set(where.userId, updated);
        return { ...updated };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          userId: string;
          stripeSubscriptionId: string;
          stripeEventCreatedAt: Date | null;
          stripeCanonicalObservedAt: Date | null;
          stripeEventId: string | null;
          stripeObservationRank: string | null;
        };
        data: Partial<Subscription>;
      }) => {
        const existing = state.subscriptions.get(where.userId);
        if (!existing) return { count: 0 };
        const eventCreatedMatches =
          existing.stripeEventCreatedAt?.getTime() ===
          where.stripeEventCreatedAt?.getTime();
        const canonicalObservedMatches =
          existing.stripeCanonicalObservedAt?.getTime() ===
          where.stripeCanonicalObservedAt?.getTime();
        if (
          existing.stripeSubscriptionId !== where.stripeSubscriptionId ||
          existing.stripeEventId !== where.stripeEventId ||
          existing.stripeObservationRank !== where.stripeObservationRank ||
          !eventCreatedMatches ||
          !canonicalObservedMatches
        ) {
          return { count: 0 };
        }
        state.subscriptions.set(where.userId, {
          ...existing,
          ...data,
          updatedAt: now(),
        });
        return { count: 1 };
      },
    },
    subscriptionEntitlementHold: {
      findFirst: async () => null,
    },
    proCheckoutAttempt: {
      findUnique: async ({ where }: { where: { userId: string } }) => {
        const attempt = state.proCheckoutAttempts.get(where.userId);
        return attempt ? { ...attempt } : null;
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { userId: string };
        create: {
          userId: string;
          billingOfferId: string;
          checkoutKey: string;
          expiresAt: Date;
        };
        update: {
          checkoutKey: string;
          billingOfferId: string;
          stripeCheckoutSessionId: null;
          expiresAt: Date;
        };
      }) => {
        const existing = state.proCheckoutAttempts.get(where.userId);
        const attempt: ProCheckoutAttempt = existing
          ? { ...existing, ...update, updatedAt: now() }
          : {
              ...create,
              stripeCheckoutSessionId: null,
              createdAt: now(),
              updatedAt: now(),
            };
        state.proCheckoutAttempts.set(where.userId, attempt);
        return { ...attempt };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          userId: string;
          checkoutKey?: string;
          stripeCheckoutSessionId?: string | null;
        };
        data: Partial<
          Pick<
            ProCheckoutAttempt,
            "stripeCheckoutSessionId" | "expiresAt"
          >
        >;
      }) => {
        const existing = state.proCheckoutAttempts.get(where.userId);
        if (
          !existing ||
          (where.checkoutKey && existing.checkoutKey !== where.checkoutKey) ||
          (where.stripeCheckoutSessionId !== undefined &&
            existing.stripeCheckoutSessionId !==
              where.stripeCheckoutSessionId)
        ) {
          return { count: 0 };
        }
        state.proCheckoutAttempts.set(where.userId, {
          ...existing,
          ...data,
          updatedAt: now(),
        });
        return { count: 1 };
      },
      deleteMany: async ({
        where,
      }: {
        where: {
          userId: string;
          checkoutKey?: string;
          stripeCheckoutSessionId?: string;
        };
      }) => {
        const existing = state.proCheckoutAttempts.get(where.userId);
        if (
          !existing ||
          (where.checkoutKey !== undefined &&
            existing.checkoutKey !== where.checkoutKey) ||
          (where.stripeCheckoutSessionId !== undefined &&
            existing.stripeCheckoutSessionId !== where.stripeCheckoutSessionId)
        ) {
          return { count: 0 };
        }
        state.proCheckoutAttempts.delete(where.userId);
        return { count: 1 };
      },
    },
    topUpCheckoutAttempt: {
      create: async ({
        data,
      }: {
        data: Pick<
          TopUpCheckoutAttempt,
          | "ownerUserId"
          | "stripeCustomerId"
          | "billingOfferId"
          | "status"
          | "expiresAt"
        >;
      }) => {
        const timestamp = now();
        const attempt: TopUpCheckoutAttempt = {
          id: crypto.randomUUID(),
          ...data,
          stripeCheckoutSessionId: null,
          stripePaymentIntentId: null,
          accountDeletionAt: null,
          fulfilledAt: null,
          refundId: null,
          refundStatus: null,
          refundStatusObservedAt: null,
          refundTargetAmount: null,
          refundSucceededAmount: 0,
          refundPendingAmount: 0,
          refundCurrency: null,
          refundNotBefore: null,
          refundLeaseToken: null,
          refundLeaseExpiresAt: null,
          refundAttempts: 0,
          refundLastError: null,
          refundInterventionAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        state.topUpCheckoutAttempts.set(attempt.id, attempt);
        return { ...attempt };
      },
      findUnique: async ({
        where,
      }: {
        where: {
          id?: string;
          stripeCheckoutSessionId?: string;
          stripePaymentIntentId?: string;
        };
        include?: { billingOffer?: boolean };
        select?: Record<string, boolean>;
      }) => {
        const attempt = [...state.topUpCheckoutAttempts.values()].find(
          (item) =>
            (where.id !== undefined && item.id === where.id) ||
            (where.stripeCheckoutSessionId !== undefined &&
              item.stripeCheckoutSessionId === where.stripeCheckoutSessionId) ||
            (where.stripePaymentIntentId !== undefined &&
              item.stripePaymentIntentId === where.stripePaymentIntentId),
        );
        return attempt ? { ...attempt } : null;
      },
      findMany: async ({
        where,
        orderBy,
        take,
      }: {
        where: TopUpCheckoutAttemptWhere;
        orderBy?: Array<
          | { refundNotBefore: "asc" | "desc" }
          | { createdAt: "asc" | "desc" }
        >;
        take?: number;
      }) => {
        const attempts = [...state.topUpCheckoutAttempts.values()]
          .filter((attempt) =>
            matchesTopUpCheckoutAttemptWhere(attempt, where))
          .sort((left, right) => {
            for (const ordering of orderBy ?? []) {
              if ("refundNotBefore" in ordering) {
                const direction = ordering.refundNotBefore === "asc" ? 1 : -1;
                const difference =
                  (left.refundNotBefore?.getTime() ?? Number.NEGATIVE_INFINITY) -
                  (right.refundNotBefore?.getTime() ?? Number.NEGATIVE_INFINITY);
                if (difference !== 0) return direction * difference;
              } else {
                const direction = ordering.createdAt === "asc" ? 1 : -1;
                const difference =
                  left.createdAt.getTime() - right.createdAt.getTime();
                if (difference !== 0) return direction * difference;
              }
            }
            return 0;
          });
        return (take === undefined ? attempts : attempts.slice(0, take)).map(
          (attempt) => ({ ...attempt }),
        );
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: TopUpCheckoutAttemptWhere;
        data: Partial<Omit<TopUpCheckoutAttempt, "refundAttempts">> & {
          refundAttempts?: number | { increment: number };
        };
      }) => {
        let count = 0;
        for (const [id, attempt] of state.topUpCheckoutAttempts) {
          if (!matchesTopUpCheckoutAttemptWhere(attempt, where)) continue;
          const { refundAttempts, ...values } = data;
          state.topUpCheckoutAttempts.set(id, {
            ...attempt,
            ...values,
            refundAttempts:
              typeof refundAttempts === "number"
                ? refundAttempts
                : attempt.refundAttempts + (refundAttempts?.increment ?? 0),
            updatedAt: now(),
          });
          count++;
        }
        return { count };
      },
    },
    billingRefundAttempt: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { sourceKey: string };
        create: Pick<
          BillingRefundAttempt,
          | "disposition"
          | "sourceKey"
          | "stripeCustomerId"
          | "stripeCheckoutSessionId"
          | "stripeSubscriptionId"
          | "stripeInvoiceId"
          | "stripePaymentIntentId"
          | "status"
          | "notBefore"
        >;
        update: Partial<BillingRefundAttempt>;
      }) => {
        const existing = [...state.billingRefundAttempts.values()].find(
          (attempt) => attempt.sourceKey === where.sourceKey,
        );
        if (existing) {
          const updated = { ...existing, ...update, updatedAt: now() };
          state.billingRefundAttempts.set(existing.id, updated);
          return { ...updated };
        }
        const timestamp = now();
        const attempt: BillingRefundAttempt = {
          id: crypto.randomUUID(),
          ...create,
          cancellationCompletedAt: null,
          targetAmount: null,
          succeededAmount: 0,
          pendingAmount: 0,
          currency: null,
          refundId: null,
          refundStatus: null,
          refundStatusObservedAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          attempts: 0,
          lastError: null,
          interventionAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        state.billingRefundAttempts.set(attempt.id, attempt);
        return { ...attempt };
      },
      findUnique: async ({
        where,
      }: {
        where: {
          id?: string;
          sourceKey?: string;
          stripePaymentIntentId?: string;
        };
      }) => {
        const attempt = [...state.billingRefundAttempts.values()].find(
          (item) =>
            (where.id !== undefined && item.id === where.id) ||
            (where.sourceKey !== undefined && item.sourceKey === where.sourceKey) ||
            (where.stripePaymentIntentId !== undefined &&
              item.stripePaymentIntentId === where.stripePaymentIntentId),
        );
        return attempt ? { ...attempt } : null;
      },
      findMany: async ({
        where,
        orderBy,
        take,
      }: {
        where: BillingRefundAttemptWhere;
        orderBy?: Array<
          | { notBefore: "asc" | "desc" }
          | { createdAt: "asc" | "desc" }
        >;
        take?: number;
      }) => {
        const attempts = [...state.billingRefundAttempts.values()]
          .filter((attempt) => matchesBillingRefundAttemptWhere(attempt, where))
          .sort((left, right) => {
            for (const ordering of orderBy ?? []) {
              if ("notBefore" in ordering) {
                const direction = ordering.notBefore === "asc" ? 1 : -1;
                const difference =
                  (left.notBefore?.getTime() ?? Number.NEGATIVE_INFINITY) -
                  (right.notBefore?.getTime() ?? Number.NEGATIVE_INFINITY);
                if (difference !== 0) return direction * difference;
              } else {
                const direction = ordering.createdAt === "asc" ? 1 : -1;
                const difference =
                  left.createdAt.getTime() - right.createdAt.getTime();
                if (difference !== 0) return direction * difference;
              }
            }
            return 0;
          });
        return (take === undefined ? attempts : attempts.slice(0, take)).map(
          (attempt) => ({ ...attempt }),
        );
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: BillingRefundAttemptWhere;
        data: Partial<Omit<BillingRefundAttempt, "attempts">> & {
          attempts?: number | { increment: number };
        };
      }) => {
        let count = 0;
        for (const [id, attempt] of state.billingRefundAttempts) {
          if (!matchesBillingRefundAttemptWhere(attempt, where)) continue;
          const { attempts, ...values } = data;
          state.billingRefundAttempts.set(id, {
            ...attempt,
            ...values,
            attempts: typeof attempts === "number"
              ? attempts
              : attempt.attempts + (attempts?.increment ?? 0),
            updatedAt: now(),
          });
          count++;
        }
        return { count };
      },
    },
    billingOffer: {
      findFirst: async ({
        where,
      }: {
        where?: { kind?: string; checkoutEnabled?: boolean };
        orderBy?: unknown;
      } = {}) => {
        const rows = [...state.billingOffers.values()]
          .filter(
            (offer) =>
              (where?.kind === undefined || offer.kind === where.kind) &&
              (where?.checkoutEnabled === undefined ||
                offer.checkoutEnabled === where.checkoutEnabled),
          )
          // findCheckoutBillingOffer orders by updatedAt then id, both desc.
          .sort((left, right) => {
            const byUpdated =
              right.updatedAt.getTime() - left.updatedAt.getTime();
            if (byUpdated !== 0) return byUpdated;
            return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
          });
        return rows.length === 0 ? null : { ...rows[0] };
      },
    },
    aiOperationModel: {
      findMany: async () =>
        [...state.aiOperationModels.values()]
          .map((row) => ({ ...row }))
          .sort(
            (a, b) =>
              a.operation.localeCompare(b.operation) ||
              a.sortOrder - b.sortOrder ||
              a.modelId.localeCompare(b.modelId),
          ),
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { operation_modelId: { operation: string; modelId: string } };
        create: Omit<AiOperationModel, "createdAt" | "updatedAt">;
        update: Partial<Omit<AiOperationModel, "operation" | "modelId">>;
      }) => {
        const key = `${where.operation_modelId.operation}\u0000${where.operation_modelId.modelId}`;
        const existing = state.aiOperationModels.get(key);
        const record: AiOperationModel = existing
          ? { ...existing, ...update, updatedAt: now() }
          : { ...create, createdAt: now(), updatedAt: now() };
        state.aiOperationModels.set(key, record);
        return { ...record };
      },
      deleteMany: async ({
        where,
      }: {
        where: { operation?: string; modelId?: string };
      }) => {
        let count = 0;
        for (const [key, row] of [...state.aiOperationModels]) {
          if (where.operation !== undefined && where.operation !== row.operation) continue;
          if (where.modelId !== undefined && where.modelId !== row.modelId) continue;
          state.aiOperationModels.delete(key);
          count++;
        }
        return { count };
      },
    },
    aiSetting: {
      findMany: async ({
        orderBy,
      }: {
        select?: unknown;
        orderBy?: { key?: "asc" | "desc" };
      } = {}) => {
        const rows = [...state.aiSettings.values()].map((row) => ({ ...row }));
        if (orderBy?.key) {
          rows.sort((a, b) =>
            orderBy.key === "desc"
              ? b.key.localeCompare(a.key)
              : a.key.localeCompare(b.key),
          );
        }
        return rows;
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { key: string };
        create: { key: string; value: string; updatedBy?: string | null };
        update: { value?: string; updatedBy?: string | null };
      }) => {
        const existing = state.aiSettings.get(where.key);
        const record: AiSetting = existing
          ? { ...existing, ...update, updatedAt: now() }
          : {
              key: create.key,
              value: create.value,
              updatedBy: create.updatedBy ?? null,
              createdAt: now(),
              updatedAt: now(),
            };
        state.aiSettings.set(record.key, record);
        return { ...record };
      },
      deleteMany: async ({ where }: { where: { key?: string } }) => {
        let count = 0;
        for (const key of [...state.aiSettings.keys()]) {
          if (where.key !== undefined && where.key !== key) continue;
          state.aiSettings.delete(key);
          count++;
        }
        return { count };
      },
    },
    aiStorageCleanup: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { objectKey: string };
        create: {
          objectKey: string;
          aiJobId?: string | null;
          state: string;
          notBefore: Date;
        };
        update: {
          aiJobId?: string | null;
          state?: string;
          notBefore?: Date;
        };
      }) => {
        const existing = state.aiStorageCleanups.get(where.objectKey);
        const record: AiStorageCleanup = existing
          ? { ...existing, ...update, updatedAt: now() }
          : {
              objectKey: create.objectKey,
              aiJobId: create.aiJobId ?? null,
              state: create.state,
              notBefore: create.notBefore,
              createdAt: now(),
              updatedAt: now(),
            };
        state.aiStorageCleanups.set(record.objectKey, record);
        return { ...record };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { objectKey?: string; state?: string; notBefore?: Date };
        data: Partial<
          Pick<AiStorageCleanup, "notBefore" | "aiJobId" | "state">
        >;
      }) => {
        let count = 0;
        for (const [objectKey, cleanup] of state.aiStorageCleanups) {
          if (
            (!where.objectKey || objectKey === where.objectKey) &&
            (!where.state || cleanup.state === where.state) &&
            (!where.notBefore ||
              cleanup.notBefore.getTime() === where.notBefore.getTime())
          ) {
            state.aiStorageCleanups.set(objectKey, {
              ...cleanup,
              ...data,
              updatedAt: now(),
            });
            count++;
          }
        }
        return { count };
      },
      findFirst: async ({
        where,
      }: {
        where: {
          objectKey?: string;
          aiJobId?: string | null;
          state?: string;
        };
        select?: { objectKey?: boolean };
      }) => {
        const cleanup = [...state.aiStorageCleanups.values()].find(
          (item) =>
            (!where.objectKey || item.objectKey === where.objectKey) &&
            (where.aiJobId === undefined || item.aiJobId === where.aiJobId) &&
            (!where.state || item.state === where.state),
        );
        return cleanup ? { ...cleanup } : null;
      },
      deleteMany: async ({
        where,
      }: {
        where: { objectKey?: string };
      }) => {
        let count = 0;
        for (const objectKey of state.aiStorageCleanups.keys()) {
          if (!where.objectKey || objectKey === where.objectKey) {
            state.aiStorageCleanups.delete(objectKey);
            count++;
          }
        }
        return { count };
      },
      findMany: async ({
        where,
        orderBy,
        take,
      }: {
        where: { notBefore: { lte: Date } };
        orderBy?: { notBefore: "asc" | "desc" };
        take?: number;
      }) => {
        const direction = orderBy?.notBefore === "desc" ? -1 : 1;
        const records = [...state.aiStorageCleanups.values()]
          .filter(
            (cleanup) =>
              cleanup.notBefore.getTime() <= where.notBefore.lte.getTime(),
          )
          .sort(
            (left, right) =>
              direction *
              (left.notBefore.getTime() - right.notBefore.getTime()),
          );
        return (take === undefined ? records : records.slice(0, take)).map(
          (record) => ({ ...record }),
        );
      },
    },
    aiRemoteJobCleanup: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: {
          provider_providerJobId: {
            provider: string;
            providerJobId: string;
          };
        };
        create: {
          provider: string;
          providerJobId: string;
          notBefore: Date;
        };
        update: { notBefore: Date };
      }) => {
        const key = `${where.provider_providerJobId.provider}:${where.provider_providerJobId.providerJobId}`;
        const existing = state.aiRemoteJobCleanups.get(key);
        const record: AiRemoteJobCleanup = existing
          ? { ...existing, ...update, updatedAt: now() }
          : {
              ...create,
              leaseExpiresAt: null,
              attempts: 0,
              lastError: null,
              createdAt: now(),
              updatedAt: now(),
            };
        state.aiRemoteJobCleanups.set(key, record);
        return { ...record };
      },
      findMany: async ({
        where,
        orderBy,
        take,
      }: {
        where: {
          notBefore: { lte: Date };
          OR: Array<
            | { leaseExpiresAt: null }
            | { leaseExpiresAt: { lte: Date } }
          >;
        };
        orderBy?: { notBefore: "asc" | "desc" };
        take?: number;
      }) => {
        const records = [...state.aiRemoteJobCleanups.values()]
          .filter(
            (record) =>
              record.notBefore.getTime() <= where.notBefore.lte.getTime() &&
              (record.leaseExpiresAt === null ||
                record.leaseExpiresAt.getTime() <=
                  where.notBefore.lte.getTime()),
          )
          .sort((left, right) => {
            const direction = orderBy?.notBefore === "desc" ? -1 : 1;
            return (
              direction *
              (left.notBefore.getTime() - right.notBefore.getTime())
            );
          });
        return (take === undefined ? records : records.slice(0, take)).map(
          (record) => ({ ...record }),
        );
      },
      findUnique: async ({
        where,
      }: {
        where: {
          provider_providerJobId: {
            provider: string;
            providerJobId: string;
          };
        };
      }) => {
        const key = `${where.provider_providerJobId.provider}:${where.provider_providerJobId.providerJobId}`;
        const record = state.aiRemoteJobCleanups.get(key);
        return record ? { ...record } : null;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          provider: string;
          providerJobId: string;
          notBefore?: { lte: Date };
          leaseExpiresAt?: Date;
          OR?: Array<
            | { leaseExpiresAt: null }
            | { leaseExpiresAt: { lte: Date } }
          >;
        };
        data: {
          notBefore?: Date;
          leaseExpiresAt?: Date | null;
          attempts?: { increment: number };
          lastError?: string | null;
        };
      }) => {
        const key = `${where.provider}:${where.providerJobId}`;
        const existing = state.aiRemoteJobCleanups.get(key);
        const leaseMatches =
          where.leaseExpiresAt === undefined ||
          existing?.leaseExpiresAt?.getTime() ===
            where.leaseExpiresAt.getTime();
        const dueMatches =
          !where.notBefore ||
          (existing !== undefined &&
            existing.notBefore.getTime() <= where.notBefore.lte.getTime());
        const claimable =
          !where.OR ||
          (existing !== undefined &&
            (existing.leaseExpiresAt === null ||
              existing.leaseExpiresAt.getTime() <=
                (where.OR.find(
                (condition): condition is {
                    leaseExpiresAt: { lte: Date };
                  } => condition.leaseExpiresAt !== null,
                )?.leaseExpiresAt.lte.getTime() ?? Number.NEGATIVE_INFINITY)));
        if (!existing || !leaseMatches || !dueMatches || !claimable) {
          return { count: 0 };
        }
        const updated: AiRemoteJobCleanup = {
          ...existing,
          ...(data.notBefore ? { notBefore: data.notBefore } : {}),
          ...(data.leaseExpiresAt !== undefined
            ? { leaseExpiresAt: data.leaseExpiresAt }
            : {}),
          ...(data.lastError !== undefined
            ? { lastError: data.lastError }
            : {}),
          attempts:
            existing.attempts + (data.attempts?.increment ?? 0),
          updatedAt: now(),
        };
        state.aiRemoteJobCleanups.set(key, updated);
        return { count: 1 };
      },
      deleteMany: async ({
        where,
      }: {
        where: {
          provider: string;
          providerJobId: string;
          leaseExpiresAt: Date;
        };
      }) => {
        const key = `${where.provider}:${where.providerJobId}`;
        const existing = state.aiRemoteJobCleanups.get(key);
        if (
          !existing ||
          existing.leaseExpiresAt?.getTime() !== where.leaseExpiresAt.getTime()
        ) {
          return { count: 0 };
        }
        state.aiRemoteJobCleanups.delete(key);
        return { count: 1 };
      },
    },
    storageUpload: {
      create: async ({
        data,
      }: {
        data: Omit<StorageUploadRecord, "id" | "createdAt"> & {
          id?: string;
          createdAt?: Date;
        };
      }) => {
        const record: StorageUploadRecord = {
          completedFileId: null,
          ...data,
          id: data.id ?? crypto.randomUUID(),
          createdAt: data.createdAt ?? now(),
        };
        state.storageUploads.set(record.id, record);
        return { ...record };
      },
      findFirst: async ({
        where,
      }: {
        where: { id?: string; userId?: string };
      }) => {
        const found = [...state.storageUploads.values()].find(
          (item) =>
            (!where.id || item.id === where.id) &&
            (!where.userId || item.userId === where.userId),
        );
        return found ? { ...found } : null;
      },
      findMany: async ({
        where,
        take,
      }: {
        where?: { createdAt?: { lt?: Date } };
        orderBy?: unknown;
        take?: number;
      } = {}) => {
        const rows = [...state.storageUploads.values()]
          .filter((item) =>
            where?.createdAt?.lt ? item.createdAt < where.createdAt.lt : true,
          )
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
        return (take ? rows.slice(0, take) : rows).map((item) => ({ ...item }));
      },
      count: async (
        { where }: {
          where?: { userId?: string; completedFileId?: string | null };
        } = {},
      ) => {
        let total = 0;
        for (const item of state.storageUploads.values()) {
          if (where?.userId && item.userId !== where.userId) continue;
          if (
            where?.completedFileId === null && item.completedFileId !== null
          ) {
            continue;
          }
          total++;
        }
        return total;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id?: string };
        data: Partial<StorageUploadRecord>;
      }) => {
        const matched = [...state.storageUploads.values()].filter(
          (item) => !where.id || item.id === where.id,
        );
        for (const item of matched) {
          state.storageUploads.set(item.id, { ...item, ...data });
        }
        return { count: matched.length };
      },
      deleteMany: async ({ where }: { where: { id?: string } }) => {
        const removed = [...state.storageUploads.values()].filter(
          (item) => !where.id || item.id === where.id,
        );
        for (const item of removed) state.storageUploads.delete(item.id);
        return { count: removed.length };
      },
      aggregate: async (
        { where }: {
          where?: { userId?: string; completedFileId?: string | null };
        } = {},
      ) => {
        let total = BigInt(0);
        for (const item of state.storageUploads.values()) {
          if (where?.userId && item.userId !== where.userId) continue;
          if (
            where?.completedFileId === null && item.completedFileId !== null
          ) {
            continue;
          }
          total += item.size;
        }
        return { _sum: { size: total } };
      },
    },
    file: {
      aggregate: async ({
        where,
      }: {
        where?: { userId?: string };
        _sum?: { size?: boolean };
      } = {}) => {
        let total = BigInt(0);
        for (const file of state.files.values()) {
          if (where?.userId && file.userId !== where.userId) continue;
          total += BigInt(file.size);
        }
        return { _sum: { size: total } };
      },
      create: async ({
        data,
      }: {
        data: {
          id?: string;
          objectKey: string;
          name: string;
          size: number;
          mimeType: string;
          userId: string;
          visibility: string;
          sha256?: string;
        };
      }) => {
        const record: FileRecord = {
          id: data.id ?? crypto.randomUUID(),
          objectKey: data.objectKey,
          name: data.name,
          size: data.size,
          mimeType: data.mimeType,
          userId: data.userId,
          visibility: data.visibility,
          sha256: data.sha256 ?? null,
          createdAt: now(),
          updatedAt: now(),
        };
        state.files.set(record.id, record);
        return { ...record };
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: Omit<FileRecord, "createdAt" | "updatedAt">;
        update: Partial<FileRecord>;
      }) => {
        const existing = state.files.get(where.id);
        const record: FileRecord = existing
          ? { ...existing, ...update, updatedAt: now() }
          : { ...create, createdAt: now(), updatedAt: now() };
        state.files.set(where.id, record);
        return { ...record };
      },
      findFirst: async ({
        where,
      }: {
        where: {
          id?: string;
          userId?: string;
          visibility?: string;
          aiJobResult?: null;
        };
        select?: { id?: boolean; objectKey?: boolean };
      }) => {
        const file = [...state.files.values()].find(
          (item) =>
            (!where.id || item.id === where.id) &&
            (!where.userId || item.userId === where.userId) &&
            (!where.visibility || item.visibility === where.visibility) &&
            (where.aiJobResult !== null || !aiJobResultForFile(item.id)),
        );
        const aiJobResult = file ? aiJobResultForFile(file.id) : null;
        return file
          ? {
              ...file,
              Package: [],
              Profile: [],
              PackageScreenshot: [],
              Release: [],
              aiJobResult: aiJobResult ? { id: aiJobResult.id } : null,
            }
          : null;
      },
      findMany: async ({
        where,
      }: {
        where?: {
          id?: { in: string[] };
          userId?: string;
          aiJobResult?: null;
        };
        select?: Record<string, boolean>;
      }) => {
        return [...state.files.values()]
          .filter(
            (file) =>
              (!where?.id || where.id.in.includes(file.id)) &&
              (!where?.userId || file.userId === where.userId) &&
              (where?.aiJobResult !== null || !aiJobResultForFile(file.id)),
          )
          .map((file) => ({ ...file }));
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const file = state.files.get(where.id);
        if (!file) throw new Error("File not found");
        state.files.delete(where.id);
        for (const [jobId, job] of state.aiJobs) {
          if (job.resultFileId === where.id) {
            state.aiJobs.set(jobId, {
              ...job,
              resultFileId: null,
              updatedAt: now(),
            });
          }
        }
        return { ...file };
      },
      deleteMany: async ({
        where,
      }: {
        where: {
          id?: string;
          userId?: string;
          visibility?: string;
          aiJobResult?: null;
        };
      }) => {
        let count = 0;
        for (const [id, file] of state.files) {
          if (
            (!where.id || file.id === where.id) &&
            (!where.userId || file.userId === where.userId) &&
            (!where.visibility || file.visibility === where.visibility) &&
            (where.aiJobResult !== null || !aiJobResultForFile(file.id))
          ) {
            state.files.delete(id);
            for (const [jobId, job] of state.aiJobs) {
              if (job.resultFileId === id) {
                state.aiJobs.set(jobId, {
                  ...job,
                  resultFileId: null,
                  updatedAt: now(),
                });
              }
            }
            count++;
          }
        }
        return { count };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id?: string; aiJobResult?: null };
        data: Partial<Pick<FileRecord, "visibility">>;
      }) => {
        let count = 0;
        for (const [id, file] of state.files) {
          if (
            (!where.id || id === where.id) &&
            (where.aiJobResult !== null || !aiJobResultForFile(id))
          ) {
            state.files.set(id, { ...file, ...data, updatedAt: now() });
            count++;
          }
        }
        return { count };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      let releaseTransaction!: () => void;
      const previousTransaction = transactionTail;
      transactionTail = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });
      await previousTransaction;
      const before = snapshot();
      try {
        return await fn(prisma);
      } catch (err) {
        restore(before);
        throw err;
      } finally {
        releaseTransaction();
      }
    },
  };

  return { prisma, state };
}
