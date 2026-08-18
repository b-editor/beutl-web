import { getDb, listCreditAccountUsageSnapshot } from "@beutl/db";
import { getTranslation } from "@beutl/i18n";
import Link from "next/link";
import { formatNumber } from "@/lib/format";
import {
  summarizeAiUsageDistribution,
  USAGE_DISTRIBUTION_SCAN_LIMIT,
} from "@/lib/ai-usage-distribution";

// A three-number summary of what subscribers actually consume, shown next to
// the allowance input so the value being edited has evidence beside it. It
// scans CreditAccount, so it is rendered inside a Suspense boundary: the
// settings form must not wait for it, and a save triggers a refresh of the
// whole page.
export async function AllowanceDigest({
  lang,
  monthlyUsageLimit,
}: {
  lang: string;
  monthlyUsageLimit: number;
}) {
  const { t } = await getTranslation(lang);
  const prisma = await getDb();
  const rows = await listCreditAccountUsageSnapshot({
    limit: USAGE_DISTRIBUTION_SCAN_LIMIT,
    prisma,
  });
  const distribution = summarizeAiUsageDistribution({
    rows,
    monthlyUsageLimit,
    now: new Date(),
    scanLimit: USAGE_DISTRIBUTION_SCAN_LIMIT,
  });

  const exhaustedPercent =
    distribution.measuredCount > 0
      ? Math.round(
          (distribution.exhaustedCount / distribution.measuredCount) * 100,
        )
      : null;

  return (
    <p className="text-xs text-muted-foreground">
      {distribution.quantiles && exhaustedPercent !== null
        ? t("admin:ai.plan.digest", {
            median: formatNumber(distribution.quantiles.p50, lang),
            p90: formatNumber(distribution.quantiles.p90, lang),
            exhausted: formatNumber(exhaustedPercent, lang),
            accounts: formatNumber(distribution.measuredCount, lang),
          })
        : t("admin:ai.plan.digestEmpty")}{" "}
      {/* The scan is ordered by userId, so a truncated one is a systematically
          chosen slice rather than a sample. Setting an allowance on it without
          knowing that is the failure this note prevents. */}
      {distribution.truncated &&
        `${t("admin:ai.usage.distribution.truncatedNote", {
          limit: formatNumber(USAGE_DISTRIBUTION_SCAN_LIMIT, lang),
        })} `}
      <Link
        className="underline hover:text-foreground"
        href={`/${lang}/admin/ai/usage`}
      >
        {t("admin:ai.plan.digestLink")}
      </Link>
    </p>
  );
}

// The label is resolved by the caller because a Suspense fallback cannot await
// a translator.
export function AllowanceDigestFallback({ label }: { label: string }) {
  return <p className="text-xs text-muted-foreground">{label}</p>;
}
