import { getUserDetail, USER_DETAIL_RELATION_LIMIT } from "@beutl/db";
import { formatTimestamp } from "@/lib/format";
import { getTranslation } from "@beutl/i18n";
import { notFound } from "next/navigation";
import { DeleteUserButton } from "./components";
import Link from "next/link";
import { Button } from "@beutl/ui/ui/button";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beutl/ui/ui/table";
import { requireAdmin } from "@/lib/auth-guard";
import { AiPlanSection } from "./ai-plan";
import { StoragePlanSection } from "./storage-plan";
import { SecuritySection } from "./security";
import { Badge } from "@beutl/ui/ui/badge";
import { stripeDashboardUrl } from "@/lib/stripe-dashboard";

// 残高と利用状況は台帳の現在値を示す必要がある。
export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string; id: string }>;
}) {
  const session = await requireAdmin();
  const params = await props.params;
  const { lang, id } = params;
  const { t } = await getTranslation(lang);

  const user = await getUserDetail({ userId: id });
  if (!user) {
    notFound();
  }

  // getUserDetail は上限より 1 件多く取得する。余分な 1 件は表示せず、打ち切りの判定に使う。
  const packages = user.Package.slice(0, USER_DETAIL_RELATION_LIMIT);
  const payments = user.UserPaymentHistory.slice(0, USER_DETAIL_RELATION_LIMIT);
  const feedback = user.Feedback.slice(0, USER_DETAIL_RELATION_LIMIT);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="mb-2">
          <Link href={`/${lang}/admin/users`}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("admin:users.back")}
          </Link>
        </Button>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">
            {user.name || user.email}
          </h1>
          <DeleteUserButton lang={lang} userId={user.id} />
        </div>
      </div>

      <section className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">{t("admin:users.profile")}</h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{t("admin:users.id")}</dt>
            <dd className="break-all font-mono">{user.id}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("admin:users.name")}</dt>
            <dd>{user.name || "-"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("admin:users.email")}</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("admin:users.createdAt")}</dt>
            <dd>{formatTimestamp(user.createdAt, lang)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("admin:users.emailVerified")}</dt>
            <dd>
              <Badge variant={user.emailVerified ? "default" : "secondary"}>
                {t(user.emailVerified ? "admin:users.verified" : "admin:users.unverified")}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("admin:users.stripeCustomer")}</dt>
            <dd>
              {user.Customer ? (
                <a
                  href={stripeDashboardUrl(`customers/${encodeURIComponent(user.Customer.stripeId)}`)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono underline-offset-4 hover:underline"
                >
                  {user.Customer.stripeId}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                "-"
              )}
            </dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/${lang}/admin/audit-log?userId=${encodeURIComponent(user.id)}`}>
              {t("admin:users.links.auditLog")}
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/${lang}/admin/ai/jobs?userId=${encodeURIComponent(user.id)}`}>
              {t("admin:users.links.aiJobs")}
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/${lang}/admin/packages?q=${encodeURIComponent(user.email)}`}>
              {t("admin:users.links.packages")}
            </Link>
          </Button>
        </div>
      </section>

      <SecuritySection lang={lang} userId={user.id} isSelf={user.id === session.user.id} />

      <AiPlanSection lang={lang} userId={user.id} />
      <StoragePlanSection lang={lang} userId={user.id} />

      <section className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">{t("admin:users.packages")}</h2>
        {packages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin:common.empty")}</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("admin:users.packageName")}</TableHead>
                  <TableHead>{t("admin:users.name")}</TableHead>
                  <TableHead>{t("admin:users.published")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {packages.map((pkg) => (
                  <TableRow key={pkg.id}>
                    <TableCell className="font-mono text-xs">
                      <Link
                        href={`/${lang}/admin/packages/${pkg.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {pkg.name}
                      </Link>
                    </TableCell>
                    <TableCell>{pkg.displayName || "-"}</TableCell>
                    <TableCell>
                      {t(pkg.published ? "admin:users.publishedValue" : "admin:users.draftValue")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {user.Package.length > USER_DETAIL_RELATION_LIMIT && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("admin:users.truncatedNotice", { count: USER_DETAIL_RELATION_LIMIT })}
              </p>
            )}
          </>
        )}
      </section>

      <section className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">{t("admin:users.paymentHistory")}</h2>
        {payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin:common.empty")}</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("admin:users.id")}</TableHead>
                  <TableHead>{t("admin:users.packageName")}</TableHead>
                  <TableHead>{t("admin:auditLog.createdAt")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((payment) => (
                  <TableRow key={payment.id}>
                    <TableCell className="font-mono text-xs">{payment.paymentId}</TableCell>
                    <TableCell>{payment.packageId}</TableCell>
                    <TableCell>{formatTimestamp(payment.createdAt, lang)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {user.UserPaymentHistory.length > USER_DETAIL_RELATION_LIMIT && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("admin:users.truncatedNotice", { count: USER_DETAIL_RELATION_LIMIT })}
              </p>
            )}
          </>
        )}
      </section>

      <section className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">{t("admin:users.feedback")}</h2>
        {feedback.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin:common.empty")}</p>
        ) : (
          <>
            <ul className="divide-y">
              {feedback.map((item) => (
                <li key={item.id} className="py-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="whitespace-pre-wrap break-words text-sm font-medium">{item.message}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatTimestamp(item.createdAt, lang)}
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t(`admin:category.${item.category}`)}
                  </div>
                </li>
              ))}
            </ul>
            {user.Feedback.length > USER_DETAIL_RELATION_LIMIT && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("admin:users.truncatedNotice", { count: USER_DETAIL_RELATION_LIMIT })}
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
