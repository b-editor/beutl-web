import { listSubscriptionsForAdmin } from "@beutl/db";
import { SUBSCRIPTION_PLAN_IDS } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";
import { Badge } from "@beutl/ui/ui/badge";
import { Button } from "@beutl/ui/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beutl/ui/ui/table";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guard";
import { formatTimestamp } from "@/lib/format";
import { fetchPaginated, parsePageParam } from "@/lib/pagination";
import { firstSearchParam } from "@/lib/search-params";
import { stripeDashboardUrl } from "@/lib/stripe-dashboard";
import { Pagination } from "@/components/admin/pagination";

const PAGE_SIZE = 30;
// Stripe の Subscription.status が取りうる値。
const STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
  "incomplete",
  "incomplete_expired",
  "canceled",
] as const;

export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{
    plan?: string | string[];
    status?: string | string[];
    page?: string | string[];
  }>;
}) {
  await requireAdmin();
  const { lang } = await props.params;
  const searchParams = await props.searchParams;
  const plan = SUBSCRIPTION_PLAN_IDS.find((value) => value === firstSearchParam(searchParams.plan));
  const status = STATUSES.find((value) => value === firstSearchParam(searchParams.status));
  const { t } = await getTranslation(lang);

  const { result, currentPage, totalPages } = await fetchPaginated(
    (pageNumber) =>
      listSubscriptionsForAdmin({ planId: plan, status, page: pageNumber, pageSize: PAGE_SIZE }),
    parsePageParam(searchParams.page),
    PAGE_SIZE,
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">{t("admin:payments.subscriptions.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("admin:payments.subscriptions.description")}
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-2">
        <select
          name="plan"
          defaultValue={plan ?? ""}
          aria-label={t("admin:payments.subscriptions.plan")}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">{t("admin:payments.subscriptions.allPlans")}</option>
          {SUBSCRIPTION_PLAN_IDS.map((value) => (
            <option key={value} value={value}>{t(`admin:payments.subscriptions.planName.${value}`)}</option>
          ))}
        </select>
        <select
          name="status"
          defaultValue={status ?? ""}
          aria-label={t("admin:feedback.status")}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">{t("admin:feedback.allStatuses")}</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        <Button type="submit" variant="outline">{t("admin:auditLog.apply")}</Button>
      </form>

      {result.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("admin:common.empty")}</p>
      ) : (
        <>
          <div className="rounded-md border">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("admin:payments.subscriptions.user")}</TableHead>
                  <TableHead>{t("admin:payments.subscriptions.plan")}</TableHead>
                  <TableHead>{t("admin:feedback.status")}</TableHead>
                  <TableHead>{t("admin:payments.subscriptions.periodEnd")}</TableHead>
                  <TableHead>{t("admin:payments.subscriptions.updatedAt")}</TableHead>
                  <TableHead>Stripe</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.items.map((row) => (
                  <TableRow key={row.stripeSubscriptionId}>
                    <TableCell>
                      <Link
                        href={`/${lang}/admin/users/${row.userId}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {row.user.name || row.user.email}
                      </Link>
                      <div className="text-xs text-muted-foreground">{row.user.email}</div>
                    </TableCell>
                    <TableCell>
                      {t(`admin:payments.subscriptions.planName.${row.planId}`, { defaultValue: row.planId })}
                      {row.tier && <span className="ml-1 text-xs text-muted-foreground">({row.tier})</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.status === "active" ? "default" : "secondary"}>{row.status}</Badge>
                      {(row.cancelAtPeriodEnd || row.cancelAt) && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {t("admin:payments.subscriptions.cancelScheduled")}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.currentPeriodEnd ? formatTimestamp(row.currentPeriodEnd, lang) : "-"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTimestamp(row.updatedAt, lang)}
                    </TableCell>
                    <TableCell>
                      <a
                        href={stripeDashboardUrl(`subscriptions/${encodeURIComponent(row.stripeSubscriptionId)}`)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-mono text-xs underline-offset-4 hover:underline"
                      >
                        {row.stripeSubscriptionId}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <Pagination
            basePath={`/${lang}/admin/payments/subscriptions`}
            params={{ plan, status }}
            currentPage={currentPage}
            totalPages={totalPages}
            previousLabel={t("admin:common.previousPage")}
            nextLabel={t("admin:common.nextPage")}
          />
        </>
      )}
    </div>
  );
}
