import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  getAdminCreditAdjustmentTotals, getAiBalanceTotals, getAiJobUsageByKind,
  getAiUsageTotals, getTopAiUsers,
} from "@beutl/db";
import { decimalNumber } from "../../packages/db/src/decimal";

const since = new Date("2026-09-01T00:00:00.000Z");
const decimal = (value: string) => new Prisma.Decimal(value);

describe("AI aggregate ranges are not individual ledger row limits", () => {
  it.each([3_000_000_000.125, decimal("3000000000.125000")])("returns safe large reservation totals: %s", async (value) => {
    const prisma = {
      $queryRaw: vi.fn(async (query: TemplateStringsArray) => [{
        ...(query.join("").includes('GROUP BY "kind"') ? { kind: "image" } : { userId: "user-a" }),
        jobCount: BigInt(2), reservedUnits: value,
      }]),
    } as never;
    expect(await getAiJobUsageByKind({ since, prisma })).toEqual([{ kind: "image", jobCount: 2, reservedUnits: 3_000_000_000.125 }]);
    expect(await getTopAiUsers({ since, limit: 10, prisma })).toEqual([{ userId: "user-a", jobCount: 2, reservedUnits: 3_000_000_000.125 }]);
  });

  it("returns large usage, purchase, adjustment, and balance totals without relaxing row validation", async () => {
    const total = decimal("3000000000.125000");
    const prisma = {
      creditTransaction: {
        groupBy: vi.fn(async () => [
          { kind: "usage", _sum: { usageAmount: total, creditAmount: 0 } },
          { kind: "purchase", _sum: { usageAmount: 0, creditAmount: total } },
          { kind: "admin_usage_adjustment", _sum: { usageAmount: total.negated(), creditAmount: 0 } },
        ]),
        findMany: vi.fn(async () => [
          { creditAmount: decimal("1500000000.062500") }, { creditAmount: decimal("1500000000.062500") },
          { creditAmount: decimal("-1500000000.062500") }, { creditAmount: decimal("-1500000000.062500") },
        ]),
      },
      creditAccount: { aggregate: vi.fn(async () => ({
        _count: { _all: 3001 },
        _sum: { monthlyUsageUsed: total, purchasedCredits: total, purchasedCreditDebt: total },
      })) },
    } as never;
    expect(await getAiUsageTotals({ since, prisma })).toEqual({ consumedUnits: 3_000_000_000.125, purchasedCredits: 3_000_000_000.125, adminUsageAdjustment: -3_000_000_000.125 });
    expect(await getAiBalanceTotals({ now: since, prisma })).toEqual({ accountCount: 3001, monthlyUsageUsed: 3_000_000_000.125, purchasedCredits: 3_000_000_000.125, purchasedCreditDebt: 3_000_000_000.125 });
    expect(await getAdminCreditAdjustmentTotals({ since, prisma })).toEqual({ granted: 3_000_000_000.125, revoked: 3_000_000_000.125 });
    expect(() => decimalNumber(total)).toThrow(RangeError);
  });

  it("keeps micro-units through large aggregate cancellation before converting to numbers", async () => {
    const prisma = { creditTransaction: { groupBy: vi.fn(async () => [
      { kind: "usage", _sum: { usageAmount: decimal("10000000000.000001"), creditAmount: 0 } },
      { kind: "usage_settlement", _sum: { usageAmount: decimal("-10000000000"), creditAmount: 0 } },
      { kind: "purchase", _sum: { usageAmount: 0, creditAmount: decimal("10000000000.000001") } },
      { kind: "purchase_reversal", _sum: { usageAmount: 0, creditAmount: decimal("-10000000000") } },
    ]) } } as never;
    expect(await getAiUsageTotals({ since, prisma })).toEqual({ consumedUnits: 0.000001, purchasedCredits: 0.000001, adminUsageAdjustment: 0 });
  });

  it.each(["9007199254.740992", "-9007199254.740992", "9000000000.000001", "NaN", "Infinity"])(
    "refuses aggregate %s when a number cannot retain safe micro-unit precision", async (value) => {
      const prisma = { $queryRaw: vi.fn(async () => [{ kind: "image", jobCount: BigInt(1), reservedUnits: decimal(value) }]) } as never;
      await expect(getAiJobUsageByKind({ since, prisma })).rejects.toThrow(RangeError);
    },
  );
});
