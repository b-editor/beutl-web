import { countFeedback, countUsers, listAuditLogs } from "@beutl/db";
import { getTranslation } from "@beutl/i18n";
import Link from "next/link";
import { Users, MessageSquare, ScrollText } from "lucide-react";
import { requireAdmin } from "@/lib/auth-guard";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  await requireAdmin();
  const params = await props.params;
  const { lang } = params;
  const { t } = await getTranslation(lang);

  // listAuditLogs は絞り込みなしの total を返すため、総数は別クエリを発行せず流用する。
  const [userCount, openFeedbackCount, recentLogs] = await Promise.all([
    countUsers(),
    countFeedback({ status: "OPEN" }),
    listAuditLogs({ page: 1, pageSize: 10 }),
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
                  {log.createdAt.toLocaleString(lang)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
