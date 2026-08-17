import { getTranslation, type Translator } from "@beutl/i18n";
import { formatNumber } from "@/lib/format";
import type {
  AiUsageDistribution,
  AiUsageHistogramBucket,
} from "@/lib/ai-usage-distribution";

function percentOf(count: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((count / total) * 100);
}

// Where a percentile sits inside the allowance, which is the thing being
// judged. A bar answers "is the allowance too generous" faster than the raw
// unit count does.
function AllowanceGauge({
  lang,
  label,
  value,
  monthlyUsageLimit,
  tone,
}: {
  lang: string;
  label: string;
  value: number;
  monthlyUsageLimit: number;
  tone: "primary" | "muted";
}) {
  const share =
    monthlyUsageLimit > 0
      ? Math.min(Math.round((value / monthlyUsageLimit) * 100), 100)
      : 0;
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-bold tabular-nums">
        {formatNumber(value, lang)}
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {share}%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={
            tone === "primary"
              ? "h-full rounded-full bg-primary"
              : "h-full rounded-full bg-muted-foreground/50"
          }
          style={{ width: `${share}%` }}
        />
      </div>
    </div>
  );
}

function ShareCard({
  lang,
  label,
  count,
  total,
  emphasis,
}: {
  lang: string;
  label: string;
  count: number;
  total: number;
  emphasis: boolean;
}) {
  const percent = percentOf(count, total);
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={
          emphasis && percent !== null && percent >= 50
            ? "text-xl font-bold tabular-nums text-destructive"
            : "text-xl font-bold tabular-nums"
        }
      >
        {percent === null ? "-" : `${formatNumber(percent, lang)}%`}
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {formatNumber(count, lang)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={
            emphasis
              ? "h-full rounded-full bg-destructive"
              : "h-full rounded-full bg-muted-foreground/50"
          }
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
    </div>
  );
}

const BUCKET_TONES: Record<AiUsageHistogramBucket, string> = {
  zero: "bg-muted-foreground/40",
  upTo25: "bg-emerald-500",
  upTo50: "bg-emerald-500",
  upTo75: "bg-amber-500",
  upTo99: "bg-amber-500",
  exhausted: "bg-destructive",
};

function Histogram({
  lang,
  t,
  distribution,
}: {
  lang: string;
  t: Translator;
  distribution: AiUsageDistribution;
}) {
  const total = distribution.measuredCount;
  const largest = Math.max(
    ...distribution.histogram.map((entry) => entry.count),
    1,
  );
  return (
    <div className="flex flex-col gap-2">
      {distribution.histogram.map((entry) => {
        const share = percentOf(entry.count, total) ?? 0;
        return (
          <div key={entry.bucket} className="flex items-center gap-3">
            <span className="w-28 shrink-0 text-xs text-muted-foreground">
              {t(`admin:ai.usage.distribution.buckets.${entry.bucket}`)}
            </span>
            <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
              {/* Scaled to the tallest bucket so a flat distribution is still
                  readable; the share next to it keeps the real proportion. */}
              <div
                className={`h-full rounded ${BUCKET_TONES[entry.bucket]}`}
                style={{ width: `${(entry.count / largest) * 100}%` }}
              />
            </div>
            <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {formatNumber(entry.count, lang)} ({share}%)
            </span>
          </div>
        );
      })}
    </div>
  );
}

export async function AiUsageDistributionSection({
  lang,
  distribution,
  monthlyUsageLimit,
  accountCount,
  scanLimit,
}: {
  lang: string;
  distribution: AiUsageDistribution;
  monthlyUsageLimit: number;
  accountCount: number;
  scanLimit: number;
}) {
  const { t } = await getTranslation(lang);
  const { measuredCount, quantiles } = distribution;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">
          {t("admin:ai.usage.distribution.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("admin:ai.usage.distribution.description", {
            limit: formatNumber(monthlyUsageLimit, lang),
          })}
        </p>
      </div>

      {measuredCount === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("admin:ai.usage.distribution.noData", {
            stale: formatNumber(distribution.staleCount, lang),
            withoutPeriod: formatNumber(distribution.withoutPeriodCount, lang),
          })}
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {quantiles && (
              <>
                <AllowanceGauge
                  lang={lang}
                  label={t("admin:ai.usage.distribution.median")}
                  value={quantiles.p50}
                  monthlyUsageLimit={monthlyUsageLimit}
                  tone="primary"
                />
                <AllowanceGauge
                  lang={lang}
                  label={t("admin:ai.usage.distribution.p90")}
                  value={quantiles.p90}
                  monthlyUsageLimit={monthlyUsageLimit}
                  tone="primary"
                />
              </>
            )}
            <ShareCard
              lang={lang}
              label={t("admin:ai.usage.distribution.exhausted")}
              count={distribution.exhaustedCount}
              total={measuredCount}
              emphasis
            />
            <ShareCard
              lang={lang}
              label={t("admin:ai.usage.distribution.unused")}
              count={distribution.zeroCount}
              total={measuredCount}
              emphasis={false}
            />
          </div>

          <Histogram lang={lang} t={t} distribution={distribution} />

          {distribution.projected && (
            <p className="text-sm">
              {t("admin:ai.usage.distribution.projected", {
                p50: formatNumber(distribution.projected.p50, lang),
                p90: formatNumber(distribution.projected.p90, lang),
                sampleSize: formatNumber(
                  distribution.projected.sampleSize,
                  lang,
                ),
              })}
            </p>
          )}
        </>
      )}

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>
          {t("admin:ai.usage.distribution.scope", {
            measured: formatNumber(measuredCount, lang),
            accounts: formatNumber(accountCount, lang),
            stale: formatNumber(distribution.staleCount, lang),
            withoutPeriod: formatNumber(distribution.withoutPeriodCount, lang),
          })}
        </p>
        <p>{t("admin:ai.usage.distribution.censoredNote")}</p>
        <p>{t("admin:ai.usage.distribution.midPeriodNote")}</p>
        {distribution.purchasedCreditHolders > 0 && (
          <p>
            {t("admin:ai.usage.distribution.purchasedNote", {
              holders: formatNumber(distribution.purchasedCreditHolders, lang),
            })}
          </p>
        )}
        {distribution.truncated && (
          <p className="text-destructive">
            {t("admin:ai.usage.distribution.truncatedNote", {
              limit: formatNumber(scanLimit, lang),
            })}
          </p>
        )}
      </div>
    </section>
  );
}
