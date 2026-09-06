import { getTranslation } from "@beutl/i18n";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@beutl/ui/ui/table";
import { requireAdmin } from "@/lib/auth-guard";
import { formatNumber, formatSignedNumber, formatTimestamp } from "@/lib/format";
import { firstSearchParam } from "@/lib/search-params";
import { parseAiUsageRange } from "@/lib/ai-usage-range";
import { AiTabs } from "../tabs";
import { AiUsageRangeFilter } from "./filter";
import { AiUsageDistributionSection } from "./distribution";
import { getAiUsageReport, TOP_USER_LIMIT } from "./queries";

// Every visit must reflect the ledger as it stands right now.
export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ range?: string | string[] }>;
}) {
  await requireAdmin();
  const { lang } = await props.params;
  const searchParams = await props.searchParams;
  const range = parseAiUsageRange(firstSearchParam(searchParams.range));
  const { t } = await getTranslation(lang);

  const report = await getAiUsageReport({ range, now: new Date() });

  const stats = [
    {
      label: t("admin:ai.usage.consumedUnits"),
      value: formatNumber(report.totals.consumedUnits, lang),
      hint: t("admin:ai.usage.consumedUnitsHint"),
    },
    {
      label: t("admin:ai.usage.jobCount"),
      value: formatNumber(report.jobCount, lang),
      hint: t("admin:ai.usage.jobCountHint"),
    },
    {
      label: t("admin:ai.usage.activeSubscriptions"),
      value: formatNumber(report.activeSubscriptions, lang),
      hint: t("admin:ai.usage.activeSubscriptionsHint", {
        limit: formatNumber(report.monthlyUsageLimit, lang),
      }),
    },
    {
      label: t("admin:ai.usage.purchasedCredits"),
      value: formatNumber(report.totals.purchasedCredits, lang),
      hint: t("admin:ai.usage.purchasedCreditsHint"),
    },
  ];

  const balances = [
    {
      label: t("admin:ai.usage.balanceMonthlyUsed"),
      value: formatNumber(report.balances.monthlyUsageUsed, lang),
    },
    {
      label: t("admin:ai.usage.balancePurchased"),
      value: formatNumber(report.balances.purchasedCredits, lang),
    },
    {
      label: t("admin:ai.usage.balanceDebt"),
      value: formatNumber(report.balances.purchasedCreditDebt, lang),
    },
    {
      label: t("admin:ai.usage.balanceAccounts"),
      value: formatNumber(report.balances.accountCount, lang),
    },
  ];

  const adjustments = [
    {
      label: t("admin:ai.usage.adminGranted"),
      value: formatNumber(report.creditAdjustments.granted, lang),
    },
    {
      label: t("admin:ai.usage.adminRevoked"),
      value: formatNumber(report.creditAdjustments.revoked, lang),
    },
    {
      label: t("admin:ai.usage.adminUsageAdjustment"),
      value: formatSignedNumber(report.totals.adminUsageAdjustment, lang),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">{t("admin:ai.usage.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("admin:ai.usage.description")}
        </p>
      </div>

      <AiTabs lang={lang} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <AiUsageRangeFilter lang={lang} range={range} />
        <p className="text-xs text-muted-foreground">
          {t("admin:ai.usage.since", {
            timestamp: formatTimestamp(report.since, lang),
          })}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-lg border bg-card p-6">
            <div className="text-2xl font-bold">{stat.value}</div>
            <div className="text-sm font-medium">{stat.label}</div>
            <div className="mt-1 text-xs text-muted-foreground">{stat.hint}</div>
          </div>
        ))}
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">
          {t("admin:ai.usage.balanceTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("admin:ai.usage.balanceDescription")}
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {balances.map((item) => (
            <div key={item.label} className="rounded-lg border bg-card p-4">
              <div className="text-xl font-bold">{item.value}</div>
              <div className="text-xs text-muted-foreground">{item.label}</div>
            </div>
          ))}
        </div>
      </section>

      <AiUsageDistributionSection
        lang={lang}
        distribution={report.distribution}
        monthlyUsageLimit={report.monthlyUsageLimit}
        accountCount={report.balances.accountCount}
        scanLimit={report.scanLimit}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">
            {t("admin:ai.usage.byStatus")}
          </h2>
          {report.statusCounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("admin:common.empty")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("admin:ai.usage.status")}</TableHead>
                  <TableHead className="text-right">
                    {t("admin:ai.usage.jobCount")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.statusCounts.map((row) => (
                  <TableRow key={row.status}>
                    <TableCell className="font-mono text-xs">
                      {row.status}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(row.jobCount, lang)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{t("admin:ai.usage.byKind")}</h2>
          {report.kindUsage.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("admin:common.empty")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("admin:ai.usage.kind")}</TableHead>
                  <TableHead className="text-right">
                    {t("admin:ai.usage.jobCount")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("admin:ai.usage.reservedUnits")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.kindUsage.map((row) => (
                  <TableRow key={row.kind}>
                    <TableCell>
                      {t(`admin:ai.usage.jobKind.${row.kind}`, {
                        defaultValue: row.kind,
                      })}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(row.jobCount, lang)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(row.reservedUnits, lang)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">
          {t("admin:ai.usage.topUsers", { count: TOP_USER_LIMIT })}
        </h2>
        {report.topUsers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("admin:common.empty")}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin:users.email")}</TableHead>
                <TableHead className="text-right">
                  {t("admin:ai.usage.jobCount")}
                </TableHead>
                <TableHead className="text-right">
                  {t("admin:ai.usage.reservedUnits")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.topUsers.map((user) => (
                <TableRow key={user.userId}>
                  <TableCell>
                    <Link
                      className="hover:underline"
                      href={`/${lang}/admin/users/${user.userId}`}
                    >
                      {user.email ?? user.name ?? user.userId}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatNumber(user.jobCount, lang)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatNumber(user.reservedUnits, lang)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">
          {t("admin:ai.usage.adjustmentTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("admin:ai.usage.adjustmentDescription")}
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          {adjustments.map((item) => (
            <div key={item.label} className="rounded-lg border bg-card p-4">
              <div className="text-xl font-bold">{item.value}</div>
              <div className="text-xs text-muted-foreground">{item.label}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
