import { Prisma } from "@prisma/client";
import { decimalNumberRows } from "./decimal";
import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";
import {
  AI_USAGE_ACTUAL_CORRECTION_KIND,
  AI_USAGE_ESTIMATE_FINAL_KIND,
  AI_USAGE_ESTIMATE_PENDING_KIND,
} from "./credit-account";

export const ADMIN_AI_JOB_BILLING_FILTERS = [
  "all", "actual", "estimated", "pending", "legacy", "unknown", "not_settled",
] as const;
export type AdminAiJobBillingFilter = typeof ADMIN_AI_JOB_BILLING_FILTERS[number];
export type AdminAiJobBillingState = Exclude<AdminAiJobBillingFilter, "all">;

const ESTIMATE_KINDS = [
  AI_USAGE_ESTIMATE_PENDING_KIND,
  AI_USAGE_ESTIMATE_FINAL_KIND,
] as const;
const AUDIT_KINDS = [...ESTIMATE_KINDS, AI_USAGE_ACTUAL_CORRECTION_KIND];

type BillingFacts = {
  status: string;
  usageUnitUsdMicros: number | null;
  usageSettledAt: Date | null;
  providerCostUsdMicros: number | null;
  transactions: readonly { kind: string }[];
};

/** Never infer an actual charge solely from an empty legacy audit column. */
export function adminAiJobBillingState(job: BillingFacts): AdminAiJobBillingState {
  if (job.status !== "succeeded") return "not_settled";
  if (job.usageUnitUsdMicros === null) return "legacy";
  if (job.usageSettledAt === null) return "pending";
  const kinds = new Set(job.transactions.map((transaction) => transaction.kind));
  if (job.providerCostUsdMicros !== null || kinds.has(AI_USAGE_ACTUAL_CORRECTION_KIND)) {
    return "actual";
  }
  if (ESTIMATE_KINDS.some((kind) => kinds.has(kind))) return "estimated";
  return "unknown";
}

function billingWhere(billing: AdminAiJobBillingFilter): Prisma.AiJobWhereInput {
  switch (billing) {
    case "actual":
      return {
        status: "succeeded",
        usageUnitUsdMicros: { not: null },
        usageSettledAt: { not: null },
        OR: [
          { providerCostUsdMicros: { not: null } },
          { transactions: { some: { kind: AI_USAGE_ACTUAL_CORRECTION_KIND } } },
        ],
      };
    case "estimated":
      return {
        status: "succeeded",
        usageUnitUsdMicros: { not: null },
        usageSettledAt: { not: null },
        providerCostUsdMicros: null,
        transactions: {
          some: { kind: { in: [...ESTIMATE_KINDS] } },
          none: { kind: AI_USAGE_ACTUAL_CORRECTION_KIND },
        },
      };
    case "pending":
      return {
        status: "succeeded",
        usageUnitUsdMicros: { not: null },
        usageSettledAt: null,
      };
    case "legacy":
      return { status: "succeeded", usageUnitUsdMicros: null };
    case "unknown":
      return {
        status: "succeeded",
        usageUnitUsdMicros: { not: null },
        usageSettledAt: { not: null },
        providerCostUsdMicros: null,
        transactions: { none: { kind: { in: AUDIT_KINDS } } },
      };
    case "not_settled":
      return { status: { not: "succeeded" } };
    default:
      return {};
  }
}

export async function listAdminAiJobs({
  cursor,
  limit,
  kind,
  status,
  provider,
  userId,
  billing = "all",
  prisma,
}: {
  cursor?: { createdAt: Date; id: string };
  limit: number;
  kind?: string;
  status?: string;
  provider?: string;
  userId?: string;
  billing?: AdminAiJobBillingFilter;
  prisma?: PrismaTransaction;
}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Admin AI job page size must be between 1 and 100");
  }
  const db = prisma ?? await getDb();
  const where: Prisma.AiJobWhereInput = {
    AND: [
      billingWhere(billing),
      ...(kind ? [{ kind }] : []),
      ...(status ? [{ status }] : []),
      ...(provider ? [{ provider }] : []),
      ...(userId ? [{ userId }] : []),
      ...(cursor ? [{ OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ] }] : []),
    ],
  };
  const rows = await db.aiJob.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      userId: true,
      kind: true,
      provider: true,
      model: true,
      status: true,
      deletedAt: true,
      createdAt: true,
      usageUnits: true,
      reservedUsageUnits: true,
      usageUnitUsdMicros: true,
      usageSettledAt: true,
      providerCostUsdMicros: true,
      transactions: {
        where: { kind: { in: AUDIT_KINDS } },
        select: { kind: true },
      },
    },
  });
  const jobs = decimalNumberRows(rows.slice(0, limit)).map((job) => ({
    ...job,
    billingState: adminAiJobBillingState(job),
  }));
  const last = jobs.at(-1);
  return {
    jobs,
    nextCursor: rows.length > limit && last
      ? { createdAt: last.createdAt, id: last.id }
      : null,
  };
}
