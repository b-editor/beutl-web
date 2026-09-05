import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  listPackagePaymentRefundInterventions,
  resumePackagePaymentRefundIntervention,
} from "../../packages/db/src/package-payment-refund-attempt";
import { formatAmount } from "@beutl/core";

describe("package payment refund interventions", () => {
  it("lists only operator-paused attempts in oldest-first order", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "refund-51" }]);
    const count = vi.fn().mockResolvedValue(101);
    const result = await listPackagePaymentRefundInterventions({
      page: 3,
      pageSize: 25,
      prisma: { packagePaymentRefundAttempt: { findMany, count } } as never,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { status: "intervention" },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      skip: 50,
      take: 25,
    });
    expect(count).toHaveBeenCalledWith({ where: { status: "intervention" } });
    expect(result).toEqual({ items: [{ id: "refund-51" }], total: 101 });
  });

  it("resumes with an updatedAt CAS and clears the stale lease", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const now = new Date("2026-09-06T00:00:00.000Z");
    const expectedUpdatedAt = new Date("2026-09-05T00:00:00.000Z");
    const result = await resumePackagePaymentRefundIntervention({
      id: "refund-1",
      expectedUpdatedAt,
      now,
      prisma: { packagePaymentRefundAttempt: { updateMany } } as never,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "refund-1", status: "intervention", updatedAt: expectedUpdatedAt },
      data: {
        status: "required",
        notBefore: now,
        attempts: 0,
        lastError: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      },
    });
    expect(result).toEqual({ status: "resumed", updatedAt: now });
  });

  it("reports a conflict when another operator changed the row", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const result = await resumePackagePaymentRefundIntervention({
      id: "refund-1",
      expectedUpdatedAt: new Date("2026-09-05T00:00:00.000Z"),
      prisma: { packagePaymentRefundAttempt: { updateMany } } as never,
    });
    expect(result).toEqual({ status: "conflict" });
  });

  it("localizes authentication failures in the intervention client", async () => {
    const source = await readFile(
      new URL(
        "../../apps/admin/src/app/[lang]/admin/ai/package-payment-refund-interventions.tsx",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain('result.message === "Unauthenticated"');
    expect(source).toContain('t("admin:ai.interventions.common.unauthenticated")');
    expect(source).toContain('result.message === "Forbidden"');
    expect(source).toContain('t("admin:ai.interventions.common.forbidden")');
    expect(source).toContain("formatAmount(row.amount, row.currency, lang)");
    expect(source).not.toContain("row.amount} {row.currency.toUpperCase()}");
  });

  it("formats refund minor units correctly for zero- and two-decimal currencies", () => {
    expect(formatAmount(1234, "jpy", "en")).toBe("¥1,234");
    expect(formatAmount(1234, "usd", "en")).toBe("$12.34");
  });

  it("wires the admin page to pagination and the selected-attempt reconciler", async () => {
    const [pageSource, actionSource] = await Promise.all([
      readFile(
        new URL("../../apps/admin/src/app/[lang]/admin/ai/page.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../apps/admin/src/app/[lang]/admin/ai/actions.ts", import.meta.url),
        "utf8",
      ),
    ]);

    expect(pageSource).toContain("fetchPaginated(");
    expect(pageSource).toContain("packagePaymentRefundPage.result.items");
    expect(pageSource).toContain("<Pagination");
    expect(actionSource).toContain("reconcilePackagePaymentRefundAttempt({");
    expect(actionSource).not.toContain("await reconcilePackagePaymentRefunds(now, secret)");
  });
});
