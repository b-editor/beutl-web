// Shape of current-period allowance consumption across accounts.
//
// Three things make these numbers easy to misread, and the UI states all of
// them rather than hiding them:
//
// 1. Right censoring — consumption stops once the allowance runs out, so the
//    upper quantiles understate demand. The exhausted count carries that part.
// 2. Mid-period position — an account three days into its period is always
//    low. The projected figures extrapolate, but only where enough of the
//    period has elapsed to be meaningful.
// 3. Lazy reset — monthlyUsageUsed is only cleared when the account next runs
//    a job, so a row whose period already ended still holds the previous
//    period's total. Those rows are excluded and counted separately: including
//    them overstates exhaustion, dropping them silently overstates the median.
// 4. Accounts with no billing period at all — nobody who never held the plan
//    has an allowance to consume, so counting their zero would pull the median
//    and the exhaustion rate toward nothing. They are excluded and counted
//    separately for the same reason stale rows are.

// CreditAccount is indexed only by its primary key, so reading it is a full
// scan either way. The cap keeps one page load bounded; the account total is
// read separately and shown alongside it, so a truncated scan is never silent.
export const USAGE_DISTRIBUTION_SCAN_LIMIT = 20_000;

export type AiUsageDistributionRow = {
  monthlyUsageUsed: number;
  purchasedCredits: number;
  usagePeriodStart: Date | null;
  usagePeriodEnd: Date | null;
};

export type AiUsageQuantiles = {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
};

export type AiUsageDistribution = {
  totalRows: number;
  truncated: boolean;
  staleCount: number;
  withoutPeriodCount: number;
  measuredCount: number;
  zeroCount: number;
  exhaustedCount: number;
  purchasedCreditHolders: number;
  quantiles: AiUsageQuantiles | null;
  projected: { sampleSize: number; p50: number; p90: number } | null;
  histogram: { bucket: AiUsageHistogramBucket; count: number }[];
};

export type AiUsageHistogramBucket =
  | "zero"
  | "upTo25"
  | "upTo50"
  | "upTo75"
  | "upTo99"
  | "exhausted";

const HISTOGRAM_BUCKETS: AiUsageHistogramBucket[] = [
  "zero",
  "upTo25",
  "upTo50",
  "upTo75",
  "upTo99",
  "exhausted",
];

// Nearest-rank rather than interpolation. It always returns a value some
// account actually recorded, so "half the accounts used 120 units or less"
// reads literally, and the figure does not shift when the method changes.
function nearestRank(sorted: number[], quantile: number): number {
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

function bucketOf(
  used: number,
  monthlyUsageLimit: number,
): AiUsageHistogramBucket {
  if (used <= 0) return "zero";
  if (used >= monthlyUsageLimit) return "exhausted";
  const ratio = used / monthlyUsageLimit;
  if (ratio <= 0.25) return "upTo25";
  if (ratio <= 0.5) return "upTo50";
  if (ratio <= 0.75) return "upTo75";
  return "upTo99";
}

function elapsedRatio(row: AiUsageDistributionRow, now: Date): number | null {
  const { usagePeriodStart: start, usagePeriodEnd: end } = row;
  if (!start || !end) return null;
  const span = end.getTime() - start.getTime();
  if (span <= 0) return null;
  const elapsed = now.getTime() - start.getTime();
  if (elapsed <= 0) return null;
  return Math.min(elapsed / span, 1);
}

export function summarizeAiUsageDistribution({
  rows,
  monthlyUsageLimit,
  now,
  scanLimit,
  minimumElapsedRatio = 0.1,
}: {
  rows: AiUsageDistributionRow[];
  monthlyUsageLimit: number;
  now: Date;
  scanLimit: number;
  minimumElapsedRatio?: number;
}): AiUsageDistribution {
  const truncated = rows.length > scanLimit;
  const scanned = truncated ? rows.slice(0, scanLimit) : rows;

  const measured: AiUsageDistributionRow[] = [];
  let staleCount = 0;
  let withoutPeriodCount = 0;
  for (const row of scanned) {
    // A row gets its period from the subscription that spent against it. No
    // period means no allowance was ever granted to this account, so it has
    // nothing to contribute to how the allowance is being consumed.
    if (!row.usagePeriodStart || !row.usagePeriodEnd) {
      withoutPeriodCount += 1;
      continue;
    }
    if (row.usagePeriodEnd.getTime() <= now.getTime()) {
      staleCount += 1;
      continue;
    }
    measured.push(row);
  }

  const used = measured.map((row) => row.monthlyUsageUsed).sort((a, b) => a - b);
  const histogram = new Map<AiUsageHistogramBucket, number>(
    HISTOGRAM_BUCKETS.map((bucket) => [bucket, 0]),
  );
  let zeroCount = 0;
  let exhaustedCount = 0;
  const projectedSamples: number[] = [];

  // Holding purchased credits says nothing about a billing period, so this one
  // is counted over everything scanned rather than over the measured subset.
  const purchasedCreditHolders = scanned.filter(
    (row) => row.purchasedCredits > 0,
  ).length;

  for (const row of measured) {
    if (row.monthlyUsageUsed <= 0) zeroCount += 1;
    // A lowered allowance can leave an account above the new limit; that still
    // counts as exhausted.
    if (monthlyUsageLimit > 0 && row.monthlyUsageUsed >= monthlyUsageLimit) {
      exhaustedCount += 1;
    }
    if (monthlyUsageLimit > 0) {
      const bucket = bucketOf(row.monthlyUsageUsed, monthlyUsageLimit);
      histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
    }

    const ratio = elapsedRatio(row, now);
    // Early in a period a single job extrapolates to an absurd total, so those
    // rows are left out of the projection entirely.
    if (ratio !== null && ratio >= minimumElapsedRatio) {
      projectedSamples.push(row.monthlyUsageUsed / ratio);
    }
  }

  const projectedSorted = projectedSamples.sort((a, b) => a - b);

  return {
    totalRows: scanned.length,
    truncated,
    staleCount,
    withoutPeriodCount,
    measuredCount: measured.length,
    zeroCount,
    exhaustedCount,
    purchasedCreditHolders,
    quantiles:
      used.length === 0
        ? null
        : {
            p50: nearestRank(used, 0.5),
            p75: nearestRank(used, 0.75),
            p90: nearestRank(used, 0.9),
            p95: nearestRank(used, 0.95),
          },
    projected:
      projectedSorted.length === 0
        ? null
        : {
            sampleSize: projectedSorted.length,
            p50: Math.round(nearestRank(projectedSorted, 0.5)),
            p90: Math.round(nearestRank(projectedSorted, 0.9)),
          },
    histogram: HISTOGRAM_BUCKETS.map((bucket) => ({
      bucket,
      count: histogram.get(bucket) ?? 0,
    })),
  };
}
