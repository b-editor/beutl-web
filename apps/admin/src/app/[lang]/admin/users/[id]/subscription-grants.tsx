import {
  getDb,
  listSubscriptionGrantsByUserId,
  listUserLabels,
} from "@beutl/db";
import {
  SUBSCRIPTION_PLAN_IDS,
  SUBSCRIPTION_PLANS,
  subscriptionGrantStatus,
  type SubscriptionGrantStatus,
} from "@beutl/core";
import { getTranslation, type Translator } from "@beutl/i18n";
import { Badge } from "@beutl/ui/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@beutl/ui/ui/table";
import { formatTimestamp } from "@/lib/format";
import {
  RevokeSubscriptionGrantButton,
  SubscriptionGrantForm,
  type SubscriptionGrantPlanOption,
} from "./subscription-grant-form";

// 値は React が描画時にエスケープするので、i18next には二重にエスケープさせない
// (日時の "/" が "&#x2F;" のまま出る)。
const RAW = { interpolation: { escapeValue: false } } as const;

function grantPlanLabel(t: Translator, planId: string, tier: string | null) {
  if (planId === "storage") {
    return t("admin:users.grants.plans.storage", {
      tier: tier ? t(`admin:storage.tiers.${tier}`, { defaultValue: tier }) : "-",
      ...RAW,
    });
  }
  return t(`admin:users.grants.plans.${planId}`, { defaultValue: planId });
}

const STATUS_VARIANT: Record<SubscriptionGrantStatus, "default" | "secondary" | "outline"> = {
  scheduled: "secondary",
  active: "default",
  expired: "secondary",
  revoked: "outline",
};

// Stripe を通さずにプランを与える操作と、その履歴。付与が効いている間の権利は
// AI・ストレージの各節にも「付与」として出る。
export async function SubscriptionGrantSection({
  lang,
  userId,
}: {
  lang: string;
  userId: string;
}) {
  const { t } = await getTranslation(lang);
  const prisma = await getDb();
  const grants = await listSubscriptionGrantsByUserId({ userId, prisma });
  const granters = await listUserLabels({
    userIds: [...new Set(grants.map((grant) => grant.grantedByUserId))],
    prisma,
  });
  const granterLabels = new Map(
    granters.map((user) => [user.id, user.name || user.email]),
  );
  const now = new Date();

  // 付与できるのはプランとティアの組。ティアの無いプランは 1 つだけ。
  const planOptions = SUBSCRIPTION_PLAN_IDS.flatMap(
    (planId): SubscriptionGrantPlanOption[] => {
      const tiers = SUBSCRIPTION_PLANS[planId].tierIds;
      return tiers.length === 0
        ? [{ value: planId, label: grantPlanLabel(t, planId, null), planId, tier: null }]
        : tiers.map((tier) => ({
            value: `${planId}:${tier}`,
            label: grantPlanLabel(t, planId, tier),
            planId,
            tier,
          }));
    },
  );

  return (
    <section className="rounded-lg border bg-card p-6">
      <h2 className="mb-1 text-lg font-semibold">{t("admin:users.grants.title")}</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        {t("admin:users.grants.description")}
      </p>

      <SubscriptionGrantForm lang={lang} userId={userId} planOptions={planOptions} />

      <div className="mt-6 border-t pt-6">
        <h3 className="mb-2 text-sm font-semibold">{t("admin:users.grants.history")}</h3>
        {grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin:common.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin:users.grants.plan")}</TableHead>
                <TableHead>{t("admin:users.grants.period")}</TableHead>
                <TableHead>{t("admin:users.grants.status")}</TableHead>
                <TableHead>{t("admin:users.grants.reason")}</TableHead>
                <TableHead>{t("admin:users.grants.grantedBy")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {grants.map((grant) => {
                const status = subscriptionGrantStatus(grant, now);
                const planLabel = grantPlanLabel(t, grant.planId, grant.tier);
                return (
                  <TableRow key={grant.id}>
                    <TableCell className="font-medium">{planLabel}</TableCell>
                    <TableCell className="text-xs">
                      {formatTimestamp(grant.startsAt, lang)} –{" "}
                      {grant.endsAt
                        ? formatTimestamp(grant.endsAt, lang)
                        : t("admin:users.grants.noEnd")}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge variant={STATUS_VARIANT[status]} className="w-fit">
                          {t(`admin:users.grants.statuses.${status}`)}
                        </Badge>
                        {grant.revokedAt && (
                          <span className="text-xs text-muted-foreground">
                            {t("admin:users.grants.revokedAt", {
                              date: formatTimestamp(grant.revokedAt, lang),
                              ...RAW,
                            })}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-40 max-w-64 whitespace-pre-wrap break-words text-sm">
                      {grant.reason}
                    </TableCell>
                    <TableCell className="text-xs">
                      {granterLabels.get(grant.grantedByUserId) ?? grant.grantedByUserId}
                    </TableCell>
                    <TableCell className="text-right">
                      {(status === "active" || status === "scheduled") && (
                        <RevokeSubscriptionGrantButton
                          lang={lang}
                          userId={userId}
                          grantId={grant.id}
                          planLabel={planLabel}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
