import {
  findAccountDeletionIntentByUserId,
  findCreditAccount,
  getMonthlyUsageAccount,
  getSubscriptionByUserId,
  startRetryableTransaction,
} from "@beutl/db";
import { AI_PRICING_CATALOG, PRO_PLAN, aiMinimumQuantityOf } from "./pricing";
import { loadAiSettings, type AiSettingsSnapshot } from "./settings";

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
export type AiOperationAvailability = Record<string, boolean>;

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
};

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
      isExhausted: getMonthlyUsageRemaining(balance) <= 0,
    },
    additionalCredits: balance.additionalCredits,
    hasAdditionalCreditDebt: balance.additionalCreditDebt > 0,
  };
}

// The smallest charge an operation can actually incur: the configured unit
// price times the smallest request its entry point accepts. Using one unit
// would report a four-second video as startable on a quarter of what it costs,
// and the reservation would then reject a prompt the user had already written.
function minimumChargeFor(
  operation: string,
  settings: AiSettingsSnapshot,
): number {
  const minimumQuantity = aiMinimumQuantityOf(operation);
  if (minimumQuantity === null) {
    return 0;
  }
  return settings.getPrice(operation) * minimumQuantity;
}

export function toAiOperationAvailability(
  balance: AiBalanceSnapshot,
  canUseAi: boolean,
  settings: AiSettingsSnapshot,
): AiOperationAvailability {
  const available = getMonthlyUsageRemaining(balance) + balance.additionalCredits;
  const availability: AiOperationAvailability = {};
  for (const operation of Object.keys(AI_PRICING_CATALOG)) {
    const minimumCharge = minimumChargeFor(operation, settings);
    availability[operation] =
      canUseAi && minimumCharge > 0 && available >= minimumCharge;
  }
  return availability;
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

export async function getEntitlements(
  userId: string,
): Promise<EntitlementsResponse> {
  return await startRetryableTransaction(async (prisma) => {
    const subscription = await getSubscriptionByUserId({ userId, prisma });
    const settings = await loadAiSettings({ prisma });
    const isActive = isActiveProSubscription(subscription);
    const effectiveEnd = subscription
      ? getEffectiveSubscriptionEnd(subscription)
      : null;
    // Reading what someone is entitled to must not create a ledger row for
    // them. A subscriber's account is opened by the operation that first spends
    // against it; everyone else — every signed-in visitor to a page that shows
    // an allowance — reads as an empty balance and leaves nothing behind.
    const account = isActive && subscription
      ? await getMonthlyUsageAccount({
          userId,
          usagePeriod: {
            start: subscription.currentPeriodStart,
            end: subscription.currentPeriodEnd,
          },
          prisma,
        })
      : (await findCreditAccount({ userId, prisma })) ?? {
          monthlyUsageUsed: 0,
          purchasedCredits: 0,
          purchasedCreditDebt: 0,
        };
    const balance = toAiBalanceSnapshot(
      account,
      isActive ? settings.getMonthlyUsageLimit() : 0,
    );

    return {
      plan: isActive ? "pro" : null,
      subscriptionStatus: subscription?.status ?? null,
      currentPeriodStart: subscription?.currentPeriodStart
        ? subscription.currentPeriodStart.toISOString()
        : null,
      currentPeriodEnd: effectiveEnd
        ? effectiveEnd.toISOString()
        : null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd === true,
      canUseAi: isActive,
      balance: toAiBalancePresentation(balance),
      availability: toAiOperationAvailability(balance, isActive, settings),
    };
  });
}

export async function canStartAiOperation(
  userId: string,
  request: {
    operation: string;
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

    const settings = await loadAiSettings({ prisma });
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
    const requiredUsage = settings.getPrice(operation) * quantity;
    if (!Number.isSafeInteger(requiredUsage) || requiredUsage <= 0) {
      return false;
    }

    const account = await getMonthlyUsageAccount({
      userId,
      usagePeriod: {
        start: subscription.currentPeriodStart,
        end: subscription.currentPeriodEnd,
      },
      prisma,
    });
    const balance = toAiBalanceSnapshot(
      account,
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
