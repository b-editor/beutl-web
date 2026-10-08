// 管理者が Stripe を通さずに与えるプランの権利 (SubscriptionGrant)。請求が無いので
// 請求期間も無いが、AI の月間割当は「期間」ごとに戻るため、付与の開始から 1 か月
// ごとの区切りをここで決める。権利の判定は Stripe の契約と同じ isActiveSubscription
// を通るよう、付与を SubscriptionState の形に組み直す。

// 付与の理由の上限。監査ログにそのまま入る。
export const SUBSCRIPTION_GRANT_REASON_MAX_LENGTH = 500;

// 管理画面で選べる期間 (か月)。サーバーは 1 から上限までの任意の整数を受け付ける。
export const SUBSCRIPTION_GRANT_MONTH_OPTIONS = [1, 3, 6, 12] as const;

// 期限付きの付与で選べる最も遠い終了。桁を打ち間違えた日付 (20261 年など) を
// 弾くための上限で、これより長く与えたいなら無期限を選ぶ。
export const SUBSCRIPTION_GRANT_MAX_YEARS = 10;

export type SubscriptionGrantTerm = {
  startsAt: Date;
  // null は取り消すまで続く。
  endsAt: Date | null;
  revokedAt: Date | null;
};

// scheduled は開始前。管理画面の付与は今から始まるが、DB の API は開始日を受け取る。
export type SubscriptionGrantStatus = "scheduled" | "active" | "expired" | "revoked";

// 月を足す。足した先の月にその日が無ければ月末に寄せ、時刻はそのまま保つ。毎回
// 元の日付から数えるので、1/31 → 2/28 → 3/31 と元の日に戻る (Stripe の月額と同じ)。
export function addUtcMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

export function subscriptionGrantStatus(
  grant: SubscriptionGrantTerm,
  now: Date = new Date(),
): SubscriptionGrantStatus {
  if (grant.revokedAt !== null) return "revoked";
  if (grant.endsAt !== null && grant.endsAt.getTime() <= now.getTime()) {
    return "expired";
  }
  if (grant.startsAt.getTime() > now.getTime()) return "scheduled";
  return "active";
}

// now を含む区切り。開始から 1 か月ごとに区切り、最後の区切りは付与の終了で切る。
// 付与が now に効いていなければ null。区切りは開始日だけから決まるので、同じ区切りの
// 中なら何度読んでも同じ値になり、AI の台帳は区切りが変わったときだけ割当を戻す。
export function subscriptionGrantPeriodAt(
  grant: SubscriptionGrantTerm,
  now: Date = new Date(),
): { start: Date; end: Date } | null {
  if (subscriptionGrantStatus(grant, now) !== "active") return null;
  let months =
    (now.getUTCFullYear() - grant.startsAt.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - grant.startsAt.getUTCMonth());
  // 同じ月でも、開始日の日付・時刻にまだ届いていなければ前の区切りの中にいる。
  if (addUtcMonths(grant.startsAt, months).getTime() > now.getTime()) {
    months -= 1;
  }
  const start = addUtcMonths(grant.startsAt, months);
  const next = addUtcMonths(grant.startsAt, months + 1);
  const end =
    grant.endsAt !== null && grant.endsAt.getTime() < next.getTime()
      ? grant.endsAt
      : next;
  return { start, end };
}

// 付与を契約の形に組み直したもの。status は active、Price は無い。cancelAt に付与の
// 終了を入れるので、effectiveSubscriptionEnd と「期間末で終わるか」の表示が Stripe の
// 解約予約と同じ読み方になる。
export type SubscriptionGrantState = {
  source: "grant";
  status: "active";
  planId: string;
  tier: string | null;
  billingOfferId: null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAt: Date | null;
  cancelAtPeriodEnd: boolean;
  entitlementHeld: false;
  grant: { id: string; endsAt: Date | null };
};

export function subscriptionStateOfGrant(
  grant: SubscriptionGrantTerm & {
    id: string;
    planId: string;
    tier: string | null;
  },
  now: Date = new Date(),
): SubscriptionGrantState | null {
  const period = subscriptionGrantPeriodAt(grant, now);
  if (!period) return null;
  return {
    source: "grant",
    status: "active",
    planId: grant.planId,
    tier: grant.tier,
    billingOfferId: null,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    cancelAt: grant.endsAt,
    cancelAtPeriodEnd:
      grant.endsAt !== null && grant.endsAt.getTime() <= period.end.getTime(),
    entitlementHeld: false,
    grant: { id: grant.id, endsAt: grant.endsAt },
  };
}
