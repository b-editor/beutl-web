import { countActiveSubscriptions } from "@beutl/db";
import { formatBytes, STORAGE_PLAN, STORAGE_PLAN_TIERS } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beutl/ui/ui/table";
import { requireAdmin } from "@/lib/auth-guard";
import { formatNumber } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  await requireAdmin();
  const { lang } = await props.params;
  const { t } = await getTranslation(lang);
  const subscriptions = await countActiveSubscriptions({
    now: new Date(),
    planId: STORAGE_PLAN.id,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">{t("admin:storage.usagePage.title")}</h1>
      </div>

      <div className="rounded-lg border bg-card p-6">
        <div className="text-2xl font-bold">{formatNumber(subscriptions.total, lang)}</div>
        <div className="text-sm font-medium">{t("admin:storage.activeSubscriptions")}</div>
      </div>

      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <h2 className="text-lg font-semibold">{t("admin:storage.byTier")}</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("admin:storage.tier")}</TableHead>
              <TableHead className="text-right">{t("admin:storage.quota")}</TableHead>
              <TableHead className="text-right">{t("admin:storage.count")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {STORAGE_PLAN_TIERS.map((tier) => (
              <TableRow key={tier.id}>
                <TableCell>{t(`admin:storage.tiers.${tier.id}`)}</TableCell>
                <TableCell className="text-right">{formatBytes(tier.quotaBytes)}</TableCell>
                <TableCell className="text-right">
                  {formatNumber(subscriptions.byTier[tier.id] ?? 0, lang)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
