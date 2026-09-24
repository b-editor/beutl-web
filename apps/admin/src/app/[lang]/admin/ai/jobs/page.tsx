import { listAdminAiJobs, ADMIN_AI_JOB_BILLING_FILTERS, AI_USAGE_ESTIMATE_PENDING_KIND } from "@beutl/db";
import { getTranslation } from "@beutl/i18n";
import { Button } from "@beutl/ui/ui/button";
import { Input } from "@beutl/ui/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beutl/ui/ui/table";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guard";
import { formatNumber, formatTimestamp } from "@/lib/format";
import { firstSearchParam } from "@/lib/search-params";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const KINDS = ["image", "image_edit", "stt", "translation", "video"] as const;
const STATUSES = ["queued", "running", "finalizing", "succeeded", "failed"] as const;

function choice<T extends string>(raw: string | undefined, values: readonly T[]): T | undefined {
  return values.find((value) => value === raw);
}

function cursorFromQuery(raw: string | undefined) {
  if (!raw || !/^[0-9a-z]+\.[0-9a-f-]{36}$/.test(raw)) return undefined;
  const [timestamp, id] = raw.split(".");
  const milliseconds = Number.parseInt(timestamp, 36);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return undefined;
  const createdAt = new Date(milliseconds);
  return Number.isNaN(createdAt.getTime()) ? undefined : { createdAt, id };
}

function cursorToQuery(cursor: { createdAt: Date; id: string }) {
  return `${cursor.createdAt.getTime().toString(36)}.${cursor.id}`;
}

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const { lang } = await props.params;
  const query = await props.searchParams;
  const kind = choice(firstSearchParam(query.kind), KINDS);
  const status = choice(firstSearchParam(query.status), STATUSES);
  const billing = choice(firstSearchParam(query.billing), ADMIN_AI_JOB_BILLING_FILTERS) ?? "all";
  const providerInput = firstSearchParam(query.provider)?.trim() ?? "";
  const provider = /^[a-z0-9_-]{1,80}$/i.test(providerInput) ? providerInput : "";
  const userIdInput = firstSearchParam(query.userId)?.trim() ?? "";
  const userId = /^[a-z0-9_-]{1,100}$/i.test(userIdInput) ? userIdInput : "";
  const cursor = cursorFromQuery(firstSearchParam(query.cursor));
  const { t } = await getTranslation(lang);
  const { jobs, nextCursor } = await listAdminAiJobs({
    limit: PAGE_SIZE,
    kind,
    status,
    billing,
    provider: provider || undefined,
    userId: userId || undefined,
    cursor,
  });

  const filters = new URLSearchParams();
  if (kind) filters.set("kind", kind);
  if (status) filters.set("status", status);
  if (billing !== "all") filters.set("billing", billing);
  if (provider) filters.set("provider", provider);
  if (userId) filters.set("userId", userId);
  const next = new URLSearchParams(filters);
  if (nextCursor) next.set("cursor", cursorToQuery(nextCursor));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">{t("admin:ai.jobs.title")}</h1>
      </div>
      <form method="get" className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-6">
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t("admin:ai.jobs.kind")}
          <select name="kind" defaultValue={kind ?? ""} className="h-9 rounded-md border bg-background px-3 text-sm">
            <option value="">{t("admin:ai.jobs.all")}</option>
            {KINDS.map((value) => <option key={value} value={value}>{t(`admin:ai.usage.jobKind.${value}`)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t("admin:ai.jobs.status")}
          <select name="status" defaultValue={status ?? ""} className="h-9 rounded-md border bg-background px-3 text-sm">
            <option value="">{t("admin:ai.jobs.all")}</option>
            {STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t("admin:ai.jobs.billing")}
          <select name="billing" defaultValue={billing} className="h-9 rounded-md border bg-background px-3 text-sm">
            {ADMIN_AI_JOB_BILLING_FILTERS.map((value) => <option key={value} value={value}>{t(`admin:ai.jobs.billingState.${value}`)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t("admin:ai.jobs.provider")}
          <Input name="provider" defaultValue={provider} maxLength={80} placeholder={t("admin:ai.jobs.all")} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t("admin:ai.jobs.user")}
          <Input name="userId" defaultValue={userId} maxLength={100} placeholder={t("admin:ai.jobs.userId")} />
        </label>
        <div className="flex items-end">
          <Button type="submit" className="w-full">{t("admin:ai.jobs.apply")}</Button>
        </div>
      </form>

      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("admin:common.empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table className="min-w-[1700px]">
            <TableHeader className="[&_th]:whitespace-nowrap"><TableRow>
              <TableHead>{t("admin:ai.jobs.createdAt")}</TableHead>
              <TableHead>{t("admin:ai.jobs.kind")}</TableHead>
              <TableHead>{t("admin:ai.jobs.provider")}</TableHead>
              <TableHead>{t("admin:ai.jobs.model")}</TableHead>
              <TableHead>{t("admin:ai.jobs.status")}</TableHead>
              <TableHead>{t("admin:ai.jobs.billing")}</TableHead>
              <TableHead className="text-right">{t("admin:ai.jobs.reservedUnits")}</TableHead>
              <TableHead className="text-right">{t("admin:ai.jobs.chargedUnits")}</TableHead>
              <TableHead className="text-right">{t("admin:ai.jobs.actualCost")}</TableHead>
              <TableHead>{t("admin:ai.jobs.jobId")}</TableHead>
              <TableHead>{t("admin:ai.jobs.user")}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {jobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell className="whitespace-nowrap text-xs">{formatTimestamp(job.createdAt, lang)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{choice(job.kind, KINDS) ? t(`admin:ai.usage.jobKind.${job.kind}`) : job.kind}</TableCell>
                  <TableCell className="text-xs">{job.provider}</TableCell>
                  <TableCell className="max-w-48 truncate font-mono text-xs" title={job.model ?? undefined}>{job.model ?? "—"}</TableCell>
                  <TableCell className="text-xs">{job.status}{job.deletedAt ? ` (${t("admin:ai.jobs.deleted")})` : ""}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs" title={job.billingState === "unknown" ? t("admin:ai.jobs.unknownHint") : undefined}>
                    {job.billingState === "estimated" && job.transactions.some((row) => row.kind === AI_USAGE_ESTIMATE_PENDING_KIND)
                      ? t("admin:ai.jobs.estimateAwaitingActual")
                      : t(`admin:ai.jobs.billingState.${job.billingState}`)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{job.reservedUsageUnits === null ? "—" : formatNumber(job.reservedUsageUnits, lang)}</TableCell>
                  <TableCell className="text-right tabular-nums">{job.status === "succeeded" && job.usageSettledAt ? formatNumber(job.usageUnits, lang) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{job.providerCostUsdMicros === null ? "—" : `$${(job.providerCostUsdMicros / 1_000_000).toFixed(6)}`}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{job.id}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs"><Link href={`/${lang}/admin/users/${job.userId}`} className="hover:underline">{job.userId}</Link></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {nextCursor && (
        <div className="flex justify-end">
          <Button asChild variant="outline"><Link href={`/${lang}/admin/ai/jobs?${next}`}>{t("admin:common.nextPage")}</Link></Button>
        </div>
      )}
    </div>
  );
}
