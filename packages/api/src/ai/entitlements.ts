import {
  findAccountDeletionIntentByUserId,
  findCreditAccount,
  getDb,
  getSubscriptionByUserId,
  startRetryableTransaction,
  type PrismaTransaction,
  usagePeriodsEqual,
} from "@beutl/db";
import { AI_PRICING_CATALOG, PRO_PLAN, aiMinimumQuantityOf } from "./pricing";
import { loadAiSettings } from "./settings";
import { loadAiModelCatalog, type AiModelCatalog } from "./model-catalog";
import { loadAiVideoModelCapabilities } from "./video-model-capabilities";

export type AiBalanceSnapshot = {
  monthlyUsage: {
    used: number;
    limit: number;
  };
  additionalCredits: number;
  additionalCreditDebt: number;
};

// What the account surface is allowed to show. Monthly raw units stay server-side,
// while the exact purchased-credit balance remains visible by product requirement.
export type AiBalancePresentation = {
  monthlyUsage: {
    usedPercent: number;
    remainingPercent: number;
    isExhausted: boolean;
  };
  // The account-only entitlement snapshot shows the remaining quantity the user
  // purchased. Ordinary operation responses carry no balance snapshot.
  additionalCredits: number;
  hasAdditionalCreditDebt: boolean;
};

// Whether each operation can be started right now. This replaces the price
// catalog the client used to evaluate locally.
//
// An operation is available when at least one of its models is: with several
// models at several prices, "cannot afford this operation" is no longer a
// single fact. Which ones in particular is modelAvailability.
export type AiOperationAvailability = Record<string, boolean>;

// operation -> model id -> whether that model can be started right now.
export type AiModelAvailability = Record<string, Record<string, boolean>>;

// Wire contract for GET /api/v3/user/entitlements.
export type EntitlementsResponse = {
  plan: "pro" | null;
  subscriptionStatus: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  // True when the plan stays usable until currentPeriodEnd and then stops. A
  // cancellation made in the Stripe customer portal shows up here, not in status.
  cancelAtPeriodEnd: boolean;
  canUseAi: boolean;
  balance: AiBalancePresentation;
  availability: AiOperationAvailability;
  // Keyed by the same model ids GET /api/v3/ai/capabilities lists, so a client
  // can grey out the ones it cannot pay for without knowing any price.
  modelAvailability: AiModelAvailability;
};

export type EntitlementSummaryResponse = Omit<
  EntitlementsResponse,
  "availability" | "modelAvailability"
>;

export function toAiBalanceSnapshot(
  account: {
    monthlyUsageUsed: number;
    purchasedCredits: number;
    purchasedCreditDebt: number;
  },
  monthlyUsageLimit: number,
): AiBalanceSnapshot {
  const used = Math.min(account.monthlyUsageUsed, monthlyUsageLimit);
  return {
    monthlyUsage: {
      used,
      limit: monthlyUsageLimit,
    },
    additionalCredits: account.purchasedCredits,
    additionalCreditDebt: account.purchasedCreditDebt,
  };
}

export function getMonthlyUsageRemaining(balance: AiBalanceSnapshot): number {
  return Math.max(balance.monthlyUsage.limit - balance.monthlyUsage.used, 0);
}

export function toUsedPercent(used: number, limit: number): number {
  if (limit <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

export function toAiBalancePresentation(
  balance: AiBalanceSnapshot,
): AiBalancePresentation {
  const usedPercent = toUsedPercent(
    balance.monthlyUsage.used,
    balance.monthlyUsage.limit,
  );
  return {
    monthlyUsage: {
      usedPercent,
      remainingPercent: 100 - usedPercent,
      // Spending an allowance to nothing and never having one are different
      // states. Without the limit check every visitor without a plan reads as
      // exhausted, and the AI screens tell them their allowance is used up
      // beside the notice explaining that they do not have one. An active plan
      // always carries a limit of at least one unit.
      isExhausted:
        balance.monthlyUsage.limit > 0 &&
        getMonthlyUsageRemaining(balance) <= 0,
    },
    additionalCredits: balance.additionalCredits,
    hasAdditionalCreditDebt: balance.additionalCreditDebt > 0,
  };
}

// The smallest charge a model can actually incur: its unit price times the
// smallest request the operation's entry point accepts. Using one unit would
// report a four-second video as startable on a quarter of what it costs, and
// the reservation would then reject a prompt the user had already written.
function minimumChargeFor(
  operation: string,
  modelId: string,
  priceUnits: number,
  videoCapabilities: ReadonlyMap<string, { durations: readonly number[] }>,
): number {
  const videoCapability = operation === "video.generate"
    ? videoCapabilities.get(modelId)
    : undefined;
  if (videoCapability && videoCapability.durations.length === 0) return 0;
  const minimumQuantity = videoCapability
    ? Math.min(...videoCapability.durations)
    : aiMinimumQuantityOf(operation);
  if (minimumQuantity === null) {
    return 0;
  }
  return priceUnits * minimumQuantity;
}

export function toAiOperationAvailability(
  balance: AiBalanceSnapshot,
  canUseAi: boolean,
  catalog: AiModelCatalog,
  videoCapabilities: ReadonlyMap<
    string,
    { durations: readonly number[] }
  > = new Map(),
): { availability: AiOperationAvailability; modelAvailability: AiModelAvailability } {
  const available = getMonthlyUsageRemaining(balance) + balance.additionalCredits;
  const availability: AiOperationAvailability = {};
  const modelAvailability: AiModelAvailability = {};
  for (const operation of Object.keys(AI_PRICING_CATALOG)) {
    const models: Record<string, boolean> = {};
    for (const entry of catalog.list(operation)) {
      const minimumCharge = minimumChargeFor(
        operation,
        entry.modelId,
        entry.priceUnits,
        videoCapabilities,
      );
      models[entry.modelId] =
        canUseAi && minimumCharge > 0 && available >= minimumCharge;
    }
    modelAvailability[operation] = models;
    availability[operation] = Object.values(models).some(Boolean);
  }
  return { availability, modelAvailability };
}

type SubscriptionState = {
  status: string;
  planId: string;
  billingOfferId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAt: Date | null;
  entitlementHeld?: boolean;
};

export function getEffectiveSubscriptionEnd(
  subscription: Pick<SubscriptionState, "currentPeriodEnd" | "cancelAt">,
): Date | null {
  if (subscription.currentPeriodEnd === null) return null;
  if (
    subscription.cancelAt != null &&
    subscription.cancelAt.getTime() < subscription.currentPeriodEnd.getTime()
  ) {
    return subscription.cancelAt;
  }
  return subscription.currentPeriodEnd;
}

export function isActiveProSubscription(
  subscription: SubscriptionState | null,
): boolean {
  const effectiveEnd = subscription
    ? getEffectiveSubscriptionEnd(subscription)
    : null;
  return (
    subscription?.status === "active" &&
    subscription.entitlementHeld !== true &&
    subscription.planId === PRO_PLAN.id &&
    typeof subscription.billingOfferId === "string" &&
    subscription.billingOfferId.length > 0 &&
    effectiveEnd !== null &&
    effectiveEnd.getTime() > Date.now()
  );
}

async function loadEntitlementSnapshot(
  userId: string,
  prisma: PrismaTransaction,
): Promise<{
  summary: EntitlementSummaryResponse;
  balance: AiBalanceSnapshot;
}> {
  const [subscription, deletionIntent, settings] = await Promise.all([
    getSubscriptionByUserId({ userId, prisma }),
    findAccountDeletionIntentByUserId({ userId, prisma }),
    loadAiSettings({ prisma }),
  ]);
  const isActive =
    deletionIntent === null && isActiveProSubscription(subscription);
  const effectiveEnd = subscription
    ? getEffectiveSubscriptionEnd(subscription)
    : null;
  // Reading what someone is entitled to must not touch the ledger at all —
  // not to open a row, and not to apply the period reset. A subscriber's
  // account is opened and rolled over by the operation that first spends
  // against it; until then the counter is read against the period it was
  // recorded for, which is what that operation would write anyway.
  const stored = await findCreditAccount({ userId, prisma });
  const account =
    stored === null
      ? { monthlyUsageUsed: 0, purchasedCredits: 0, purchasedCreditDebt: 0 }
      : {
          ...stored,
          monthlyUsageUsed:
            isActive &&
            subscription &&
            !usagePeriodsEqual(
              { start: stored.usagePeriodStart, end: stored.usagePeriodEnd },
              {
                start: subscription.currentPeriodStart,
                end: subscription.currentPeriodEnd,
              },
            )
              ? 0
              : stored.monthlyUsageUsed,
        };
  const balance = toAiBalanceSnapshot(
    account,
    isActive ? settings.getMonthlyUsageLimit() : 0,
  );

  return {
    summary: {
      plan: isActive ? "pro" : null,
      subscriptionStatus: subscription?.status ?? null,
      currentPeriodStart: subscription?.currentPeriodStart
        ? subscription.currentPeriodStart.toISOString()
        : null,
      currentPeriodEnd: effectiveEnd ? effectiveEnd.toISOString() : null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd === true,
      canUseAi: isActive,
      balance: toAiBalancePresentation(balance),
    },
    balance,
  };
}

// Account and billing surfaces only need the plan and balance. Keep those
// reads independent from provider capability discovery and the model catalog,
// both of which can be comparatively large on a 128 MiB Worker isolate.
export async function getEntitlementSummary(
  userId: string,
  options: { prisma?: PrismaTransaction } = {},
): Promise<EntitlementSummaryResponse> {
  // This snapshot only drives account presentation. Every paid operation
  // revalidates entitlement inside its own transaction, so keeping several UI
  // reads in an interactive transaction adds a fragile connection-start
  // deadline without providing an authorization guarantee.
  const prisma = options.prisma ?? await getDb();
  const { summary } = await loadEntitlementSnapshot(userId, prisma);
  return summary;
}

export async function getEntitlements(
  userId: string,
  options: {
    videoCapabilities?: ReadonlyMap<
      string,
      { durations: readonly number[] }
    >;
    // Server-rendered AI screens already need this catalog to build their
    // model picker. Accepting that request-local snapshot keeps affordability
    // and the picker on the same rows without reading the catalog twice.
    catalog?: AiModelCatalog;
  } = {},
): Promise<EntitlementsResponse> {
  const videoCapabilities = options.videoCapabilities ??
    await loadAiVideoModelCapabilities();
  return await startRetryableTransaction(async (prisma) => {
    const [{ summary, balance }, catalog] = await Promise.all([
      loadEntitlementSnapshot(userId, prisma),
      options.catalog
        ? Promise.resolve(options.catalog)
        : loadAiModelCatalog({ prisma }),
    ]);

    return {
      ...summary,
      ...toAiOperationAvailability(
        balance,
        summary.canUseAi,
        catalog,
        videoCapabilities,
      ),
    };
  });
}

export async function canStartAiOperation(
  userId: string,
  request: {
    operation: string;
    model?: string;
    durationSeconds?: number;
    characterCount?: number;
  },
): Promise<boolean> {
  const { operation } = request;
  if (!(operation in AI_PRICING_CATALOG)) {
    throw new RangeError("operation must identify a billable AI operation");
  }
  return await startRetryableTransaction(async (prisma) => {
    if (await findAccountDeletionIntentByUserId({ userId, prisma })) {
      return false;
    }
    const subscription = await getSubscriptionByUserId({ userId, prisma });
    if (!subscription || !isActiveProSubscription(subscription)) {
      return false;
    }

    const [settings, catalog] = await Promise.all([
      loadAiSettings({ prisma }),
      loadAiModelCatalog({ prisma }),
    ]);
    // An unknown or disabled model cannot be started at any balance, and
    // answering "yes" for it would send the user into a request the entry point
    // refuses.
    const selectedModel = catalog.resolve(operation, request.model);
    if (!selectedModel) {
      return false;
    }
    const quantity = operation === "video.generate"
      ? request.durationSeconds
      : operation === "audio.transcribe"
        ? request.durationSeconds === undefined
          ? undefined
          : Math.max(1, Math.ceil(request.durationSeconds / 60))
        : operation === "subtitle.translate"
          ? request.characterCount === undefined
            ? undefined
            : Math.max(1, Math.ceil(request.characterCount / 1_000))
          : 1;
    if (
      quantity === undefined ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0
    ) {
      throw new RangeError("operation quantity must be a positive integer");
    }
    const requiredUsage = selectedModel.priceUnits * quantity;
    if (!Number.isSafeInteger(requiredUsage) || requiredUsage <= 0) {
      return false;
    }

    // "Can this be started" is a question, not a decision to start it, so it
    // reads the counter against its recorded period rather than opening a row
    // and rolling it over the way a reservation does.
    const stored = await findCreditAccount({ userId, prisma });
    const periodIsCurrent =
      stored !== null &&
      usagePeriodsEqual(
        { start: stored.usagePeriodStart, end: stored.usagePeriodEnd },
        {
          start: subscription.currentPeriodStart,
          end: subscription.currentPeriodEnd,
        },
      );
    const balance = toAiBalanceSnapshot(
      {
        monthlyUsageUsed: periodIsCurrent ? stored.monthlyUsageUsed : 0,
        purchasedCredits: stored?.purchasedCredits ?? 0,
        purchasedCreditDebt: stored?.purchasedCreditDebt ?? 0,
      },
      settings.getMonthlyUsageLimit(),
    );
    return (
      getMonthlyUsageRemaining(balance) + balance.additionalCredits >=
      requiredUsage
    );
  });
}

export function isAiPlanActive(entitlements: EntitlementsResponse): boolean {
  return entitlements.canUseAi;
}
