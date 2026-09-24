import {
  findAccountDeletionIntentByUserId,
  findCreditAccount,
  getDb,
  getSubscription,
  startRetryableTransaction,
  type PrismaTransaction,
  usagePeriodsEqual,
} from "@beutl/db";
import {
  aiBillingUnitOf,
  ceilUsageUnits,
  USAGE_UNIT_MICROS_PER_UNIT,
  usageUnitsForProviderCost,
} from "@beutl/core";
import { AI_PRICING_CATALOG, PRO_PLAN } from "./pricing";
import { loadAiSettings } from "./settings";
import { loadAiModelCatalog, type AiModelCatalog } from "./model-catalog";
import { quoteAiOperationReservation } from "./usage-cost";
import { providerRequiresPreparedOutpaintCanvas } from "./providers/registry";

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
  return Math.max(
    Math.round(balance.monthlyUsage.limit * USAGE_UNIT_MICROS_PER_UNIT) -
      Math.round(balance.monthlyUsage.used * USAGE_UNIT_MICROS_PER_UNIT),
    0,
  ) / USAGE_UNIT_MICROS_PER_UNIT;
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

export function toAiOperationAvailability(
  balance: AiBalanceSnapshot,
  canUseAi: boolean,
  catalog: AiModelCatalog,
  rawImageInputs = false,
): { availability: AiOperationAvailability; modelAvailability: AiModelAvailability } {
  const available = getMonthlyUsageRemaining(balance) + balance.additionalCredits;
  const availability: AiOperationAvailability = {};
  const modelAvailability: AiModelAvailability = {};
  for (const operation of Object.keys(AI_PRICING_CATALOG)) {
    const models: Record<string, boolean> = {};
    for (const entry of catalog.list(operation)) {
      if (rawImageInputs && providerRequiresPreparedOutpaintCanvas(entry.provider, operation)) continue;
      models[entry.modelId] =
        canUseAi && available > 0;
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
    getSubscription({ userId, planId: PRO_PLAN.id, prisma }),
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
    // A Server Component also needs this catalog's display metadata. Accept its
    // in-flight read so entitlement availability and the form share one query
    // without serializing the rest of the snapshot behind it.
    catalog?: AiModelCatalog | PromiseLike<AiModelCatalog>;
    prisma?: PrismaTransaction;
    /** Retained for callers compiled against fixed-price affordability. */
    videoCapabilities?: unknown;
    /** The v3 API accepts raw images, unlike the Web's prepared canvas. */
    rawImageInputs?: boolean;
  } = {},
): Promise<EntitlementsResponse> {
  // This is an advisory presentation snapshot. Every paid operation repeats
  // the entitlement and balance checks in the transaction that reserves its
  // usage, so an interactive transaction here adds a connection-start deadline
  // without making the later authorization decision atomic. This is the same
  // boundary as getEntitlementSummary(), with the catalog joined for the model
  // availability shown by AI screens and clients.
  const prisma = options.prisma ?? await getDb();
  const [{ summary, balance }, catalog] = await Promise.all([
    loadEntitlementSnapshot(userId, prisma),
    options.catalog ?? loadAiModelCatalog({ prisma }),
  ]);

  return {
    ...summary,
    ...toAiOperationAvailability(
      balance,
      summary.canUseAi,
      catalog,
      options.rawImageInputs,
    ),
  };
}

export async function canStartAiOperation(
  userId: string,
  request: {
    operation: string;
    model?: string;
    durationSeconds?: number;
    characterCount?: number;
    referenceImages?: number;
    resolution?: string;
    generateAudio?: boolean;
    aspectRatio?: string;
    background?: string;
  },
  options: { rawImageInputs?: boolean } = {},
): Promise<boolean> {
  const { operation } = request;
  if (!(operation in AI_PRICING_CATALOG)) {
    throw new RangeError("operation must identify a billable AI operation");
  }
  const [settings, catalog] = await Promise.all([
    loadAiSettings(),
    loadAiModelCatalog(),
  ]);
  const selectedModel = catalog.resolve(operation, request.model);
  if (!selectedModel) return false;
  if (options.rawImageInputs && providerRequiresPreparedOutpaintCanvas(selectedModel.provider, operation)) return false;
  const quantity = aiBillingUnitOf(operation) === "second"
    ? operation === "video.edit" && request.durationSeconds !== undefined
      ? Math.ceil(request.durationSeconds)
      : request.durationSeconds
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
  const quote = await quoteAiOperationReservation({
    operation,
    quantity,
    modelId: selectedModel.modelId,
    provider: selectedModel.provider,
    imageOutputTokenProfile: selectedModel.imageOutputTokenProfile,
    request,
  });
  const requiredUsage = quote === null
    ? ceilUsageUnits(
        (selectedModel.priceUnits * quantity * selectedModel.usagePercent) /
          100,
      )
    : usageUnitsForProviderCost(
        quote.reservationProviderCostUsd,
        settings.getProviderUsdPerUsageUnit(),
        selectedModel.usagePercent,
      );
  if (requiredUsage === null || requiredUsage <= 0) return false;

  return await startRetryableTransaction(async (prisma) => {
    if (await findAccountDeletionIntentByUserId({ userId, prisma })) {
      return false;
    }
    const subscription = await getSubscription({ userId, planId: PRO_PLAN.id, prisma });
    if (!subscription || !isActiveProSubscription(subscription)) {
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
    // Compare fixed-precision integers, like the reservation writer. Comparing
    // 500 - 499.8 directly with 0.2 would reject an exactly sufficient balance.
    const availableMicros =
      Math.round(getMonthlyUsageRemaining(balance) * USAGE_UNIT_MICROS_PER_UNIT) +
      Math.round(balance.additionalCredits * USAGE_UNIT_MICROS_PER_UNIT);
    return availableMicros >=
      Math.round(requiredUsage * USAGE_UNIT_MICROS_PER_UNIT);
  });
}

export function isAiPlanActive(entitlements: EntitlementsResponse): boolean {
  return entitlements.canUseAi;
}
