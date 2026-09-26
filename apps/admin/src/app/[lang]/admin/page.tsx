import {
  countActiveSubscriptionsByPlan,
  countAdminInterventions,
  countFeedback,
  countUsers,
  FeedbackStatus,
  getDb,
  listAuditLogs,
} from "@beutl/db";
import { SUBSCRIPTION_PLAN_IDS } from "@beutl/core";
import { formatTimestamp } from "@/lib/format";
import { getTranslation } from "@beutl/i18n";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Users, MessageSquare, ScrollText } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guard";

// 対応待ちの行は一覧を開くまで見えない。滞留に気付けるよう件数をここに集める。
export const dynamic = "force-dynamic";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  await requireAdmin();
  const params = await props.params;
  const { lang } = params;
  const { t } = await getTranslation(lang);

  // Explicitly share the render-scoped client across these parallel queries.
  const prisma = await getDb();
  // listAuditLogs は絞り込みなしの total を返すため、総数は別クエリを発行せず流用する。
  const [userCount, openFeedbackCount, recentLogs, interventions, activeSubscriptions] = await Promise.all([
    countUsers({ prisma }),
    countFeedback({ status: FeedbackStatus.OPEN, prisma }),
    listAuditLogs({ page: 1, pageSize: 10, prisma }),
    countAdminInterventions({ prisma }),
    countActiveSubscriptionsByPlan({ prisma }),
  ]);
  const auditLogCount = recentLogs.total;

  const stats = [
    {
      label: t("admin:dashboard.userCount"),
      value: userCount,
      icon: Users,
      href: `/${lang}/admin/users`,
    },
    {
      label: t("admin:dashboard.openFeedbackCount"),
      value: openFeedbackCount,
      icon: MessageSquare,
      href: `/${lang}/admin/feedback`,
    },
    {
      label: t("admin:dashboard.auditLogCount"),
      value: auditLogCount,
      icon: ScrollText,
      href: `/${lang}/admin/audit-log`,
    },
  ];

  const queues = [
    {
      label: t("admin:ai.interventions.topUp.title"),
      value: interventions.topUp,
      href: `/${lang}/admin/payments`,
    },
    {
      label: t("admin:ai.interventions.packagePayment.title"),
      value: interventions.packagePaymentRefund,
      href: `/${lang}/admin/payments`,
    },
    {
      label: t("admin:dashboard.storageMultipartQueue"),
      value: interventions.storageMultipart,
      href: `/${lang}/admin/storage/interventions`,
    },
    {
      label: t("admin:dashboard.storageUploadQueue"),
      value: interventions.storageUpload,
      href: `/${lang}/admin/storage/interventions`,
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold">{t("admin:dashboard.title")}</h1>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((stat) => (
          <Link
            key={stat.label}
            href={stat.href}
            className="flex items-center gap-4 rounded-lg border bg-card p-6 text-card-foreground transition-colors hover:bg-accent/50"
          >
            <stat.icon className="h-8 w-8 text-muted-foreground" />
            <div>
              <div className="text-2xl font-bold">{stat.value}</div>
              <div className="text-sm text-muted-foreground">{stat.label}</div>
            </div>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-4 text-lg font-semibold">{t("admin:dashboard.needsAttention")}</h2>
          <ul className="divide-y rounded-lg border bg-card">
            {queues.map((queue) => (
              <li key={queue.label}>
                <Link
                  href={queue.href}
                  className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-accent/50"
                >
                  <span className="flex items-center gap-2 text-sm">
                    {queue.value > 0 ? (
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                    )}
                    {queue.label}
                  </span>
                  <span className={queue.value > 0 ? "font-bold" : "text-muted-foreground"}>
                    {queue.value}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="mb-4 text-lg font-semibold">{t("admin:dashboard.activeSubscriptions")}</h2>
          <ul className="divide-y rounded-lg border bg-card">
            {SUBSCRIPTION_PLAN_IDS.map((planId) => (
              <li key={planId}>
                <Link
                  href={`/${lang}/admin/payments/subscriptions?plan=${planId}&status=active&current=1`}
                  className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-accent/50"
                >
                  <span className="text-sm">{t(`admin:payments.subscriptions.planName.${planId}`)}</span>
                  <span className="font-bold">{activeSubscriptions[planId] ?? 0}</span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">{t("admin:dashboard.activeSubscriptionsNote")}</p>
        </section>
      </div>

      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("admin:dashboard.recentAuditLogs")}</h2>
          <Link
            href={`/${lang}/admin/audit-log`}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {t("admin:dashboard.viewAll")}
          </Link>
        </div>
        {recentLogs.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin:common.empty")}</p>
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {recentLogs.items.map((log) => (
              <li key={log.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <div className="text-sm font-medium">{log.action}</div>
                  {log.details && (
                    <div className="text-xs text-muted-foreground">{log.details}</div>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatTimestamp(log.createdAt, lang)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
