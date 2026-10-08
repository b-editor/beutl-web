import {
  effectiveSubscriptionEnd,
  isActiveSubscription,
  isSubscriptionTier,
  subscriptionPlanOf,
  subscriptionStateOfGrant,
  type SubscriptionGrantState,
  type SubscriptionPlanId,
} from "@beutl/core";
import type { SubscriptionGrant } from "@prisma/client";
import { getDb } from "./provider";
import { getSubscription } from "./subscription";
import type { PrismaTransaction } from "./transaction";
import { existsUserById } from "./user";

// 管理画面の一覧に出す件数の上限。
export const SUBSCRIPTION_GRANT_LIST_LIMIT = 20;

// 今この瞬間に効いている付与。取り消されておらず、開始済みで、終了前のもの。
// 作成時に「同じプランで効いている付与は 1 つ」を守るので、多くても 1 行。
export async function findActiveSubscriptionGrant({
  userId,
  planId,
  now = new Date(),
  prisma,
}: {
  userId: string;
  planId: string;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.subscriptionGrant.findFirst({
    where: {
      userId,
      planId,
      revokedAt: null,
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

// 新しい順の履歴。上限で切るのは終わった付与だけで、まだ終わっていない付与 (開始前を
// 含む) は上限を超えても必ず含める: 管理画面の取り消しはこの一覧から出るので、古い
// 付与が押し出されると取り消せず、作り直しも grant-exists で断られてしまう。
export async function listSubscriptionGrantsByUserId({
  userId,
  limit = SUBSCRIPTION_GRANT_LIST_LIMIT,
  now = new Date(),
  prisma,
}: {
  userId: string;
  limit?: number;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const orderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];
  const recent = await db.subscriptionGrant.findMany({
    where: { userId },
    orderBy,
    take: limit,
  });
  const open = await db.subscriptionGrant.findMany({
    where: {
      userId,
      revokedAt: null,
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
    orderBy,
  });
  const byId = new Map([...recent, ...open].map((grant) => [grant.id, grant]));
  return [...byId.values()].sort(
    (left, right) =>
      right.createdAt.getTime() - left.createdAt.getTime() ||
      (right.id < left.id ? -1 : right.id > left.id ? 1 : 0),
  );
}

type StoredSubscription = NonNullable<Awaited<ReturnType<typeof getSubscription>>>;

// 権利の判定が読む契約。Stripe の契約が今権利を与えていればそれ、与えていなければ
// 効いている付与、どちらも無ければ (解約済みや支払い待ちの表示のために) Stripe の
// 行をそのまま返す。Stripe の契約を優先するのは、支払っている人の期間・ティアを
// 付与が上書きしないため。
//
// Webhook・同期・チェックアウトのように Stripe の契約そのものを扱う処理は、これ
// ではなく getSubscription を読む。
export type EntitlementSubscription =
  | (StoredSubscription & { source: "stripe"; grant: null })
  | SubscriptionGrantState;

export async function getEntitlementSubscription({
  userId,
  planId,
  now = new Date(),
  prisma,
}: {
  userId: string;
  planId: SubscriptionPlanId;
  now?: Date;
  prisma?: PrismaTransaction;
}): Promise<EntitlementSubscription | null> {
  const stored = await getSubscription({ userId, planId, prisma });
  const subscription = stored
    ? { ...stored, source: "stripe" as const, grant: null }
    : null;
  if (isActiveSubscription(subscription, planId, now)) {
    return subscription;
  }
  const grant = await findActiveSubscriptionGrant({
    userId,
    planId,
    now,
    prisma,
  });
  return (grant && subscriptionStateOfGrant(grant, now)) ?? subscription;
}

// Stripe の契約がまだ続いているか。権利を与えているかどうかは問わない: 支払いに
// 失敗して止まっている契約も、本人が直すか Stripe が解約するまでは続いている。
// 予定した解約日を過ぎていれば、終了の通知がまだ届いていなくても終わっている。
function isOpenStripeSubscription(
  subscription: StoredSubscription | null,
  now: Date,
): boolean {
  if (!subscription) return false;
  if (
    subscription.status === "canceled" ||
    subscription.status === "incomplete_expired"
  ) {
    return false;
  }
  const end = effectiveSubscriptionEnd(subscription);
  const cancellationScheduled =
    subscription.cancelAtPeriodEnd || subscription.cancelAt !== null;
  return !(cancellationScheduled && end !== null && end.getTime() <= now.getTime());
}

export type CreateSubscriptionGrantResult =
  | { status: "created"; grant: SubscriptionGrant }
  | {
      status: "rejected";
      reason:
        | "user-not-found"
        | "invalid-plan"
        | "invalid-tier"
        | "invalid-term"
        | "grant-exists"
        | "subscription-open";
    };

// 付与を作る。呼び出し側のトランザクションの中で呼ぶ (確認と作成の間に別の付与や
// 契約が割り込まないよう、CockroachDB の SERIALIZABLE に任せる)。
//
// 同じプランで終わっていない付与 (開始前を含む) は 1 つまで。延長や変更は取り消して
// から作り直す。
// Stripe の契約が続いている人には与えない: 付与は Stripe の契約が権利を与えて
// いない間だけ効くので、支払い中の人には何も起きず、支払いに失敗している人には
// 請求画面が付与だけを見せて、直すべき契約を隠してしまう。
export async function createSubscriptionGrant({
  userId,
  planId,
  tier,
  startsAt,
  endsAt,
  reason,
  grantedByUserId,
  prisma,
}: {
  userId: string;
  planId: string;
  tier: string | null;
  startsAt: Date;
  endsAt: Date | null;
  reason: string;
  grantedByUserId: string;
  prisma: PrismaTransaction;
}): Promise<CreateSubscriptionGrantResult> {
  const plan = subscriptionPlanOf(planId);
  if (!plan) return { status: "rejected", reason: "invalid-plan" };
  if (!isSubscriptionTier(plan, tier)) {
    return { status: "rejected", reason: "invalid-tier" };
  }
  if (endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
    return { status: "rejected", reason: "invalid-term" };
  }
  if (!(await existsUserById({ id: userId, prisma }))) {
    return { status: "rejected", reason: "user-not-found" };
  }

  // 開始前の付与も数える。新しい付与の開始時点で終わっていない付与は、いずれ
  // 期間が重なる。
  const existing = await prisma.subscriptionGrant.findFirst({
    where: {
      userId,
      planId: plan.id,
      revokedAt: null,
      OR: [{ endsAt: null }, { endsAt: { gt: startsAt } }],
    },
    select: { id: true },
  });
  if (existing) return { status: "rejected", reason: "grant-exists" };
  const subscription = await getSubscription({
    userId,
    planId: plan.id,
    prisma,
  });
  if (isOpenStripeSubscription(subscription, startsAt)) {
    return { status: "rejected", reason: "subscription-open" };
  }

  const grant = await prisma.subscriptionGrant.create({
    data: {
      userId,
      planId: plan.id,
      tier,
      startsAt,
      endsAt,
      reason,
      grantedByUserId,
    },
  });
  return { status: "created", grant };
}

// 効いている付与を閉じる。終わった付与や取り消し済みの付与は動かさない (履歴の
// 終了理由を書き換えない)。閉じたら true。
export async function revokeSubscriptionGrant({
  grantId,
  userId,
  revokedByUserId,
  now = new Date(),
  prisma,
}: {
  grantId: string;
  userId: string;
  revokedByUserId: string;
  now?: Date;
  prisma: PrismaTransaction;
}) {
  const grant = await prisma.subscriptionGrant.findFirst({
    where: {
      id: grantId,
      userId,
      revokedAt: null,
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
  });
  if (!grant) return null;
  const updated = await prisma.subscriptionGrant.updateMany({
    where: { id: grant.id, revokedAt: null },
    data: { revokedAt: now, revokedByUserId },
  });
  return updated.count === 1 ? grant : null;
}
