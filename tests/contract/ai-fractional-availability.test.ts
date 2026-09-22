import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addPurchasedCredits,
  consumeUsage,
  getCreditAccount,
  setDbProvider,
  upsertAiOperationModel,
  upsertSubscription,
} from "@beutl/db";
import { canStartAiOperation } from "../../packages/api/src/ai/entitlements";
import { createReservedAiJob } from "../../packages/api/src/ai/credits";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const { loadAiCostEstimates } = vi.hoisted(() => ({
  loadAiCostEstimates: vi.fn(),
}));
vi.mock("../../packages/api/src/ai/model-pricing", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../packages/api/src/ai/model-pricing")
  >()),
  loadAiCostEstimates,
}));

const userId = "fractional-availability";
const modelId = "review/fractional";
const period = {
  start: new Date(Date.now() - 86_400_000),
  end: new Date(Date.now() + 86_400_000),
};

describe("fractional preflight and reservation parity", () => {
  beforeEach(async () => {
    const memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
    loadAiCostEstimates.mockReset();
    loadAiCostEstimates.mockResolvedValue({ entries: [] });
    await upsertSubscription({
      userId,
      stripeSubscriptionId: "sub_fractional_availability",
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro_test",
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
    });
    await upsertAiOperationModel({
      operation: "image.generate",
      modelId,
      provider: "openrouter",
      usagePercent: 20,
      priceUnits: 1,
      displayName: null,
      enabled: true,
      sortOrder: 0,
      updatedBy: "admin",
    });
  });

  it.each([
    { consumed: 499.8, credits: 0, expected: true },
    { consumed: 499.800001, credits: 0, expected: false },
    { consumed: 500.8, credits: 1, expected: true },
    { consumed: 500.800001, credits: 1, expected: false },
  ])(
    "agrees at the micro-unit boundary with $consumed consumed and $credits credits",
    async ({ consumed, credits, expected }) => {
      if (credits > 0) {
        await addPurchasedCredits({
          userId,
          amount: credits,
          stripePaymentId: "pi_fractional",
        });
      }
      await consumeUsage({
        userId,
        amount: consumed,
        monthlyUsageLimit: 500,
        usagePeriod: period,
        aiJobId: "setup",
      });

      expect(
        await canStartAiOperation(userId, {
          operation: "image.generate",
          model: modelId,
        }),
      ).toBe(expected);
      const reservation = await createReservedAiJob({
        userId,
        kind: "image",
        provider: "openrouter",
        status: "running",
        usagePercent: 20,
        model: modelId,
      });
      expect(reservation.ok).toBe(expected);
      if (reservation.ok) {
        expect(reservation.job.reservedUsageUnits).toBe(0.2);
        expect(await getCreditAccount({ userId })).toMatchObject({
          monthlyUsageUsed: 500,
          purchasedCredits: 0,
        });
      }
    },
  );

  it("accepts the exact fractional reservation from a provider quote", async () => {
    loadAiCostEstimates.mockResolvedValue({
      entries: [
        {
          estimate: {
            status: "estimated",
            usdMin: 0.005,
            usdMax: 0.005,
            assumptions: [],
          },
        },
      ],
    });
    await consumeUsage({
      userId,
      amount: 499.88,
      monthlyUsageLimit: 500,
      usagePeriod: period,
      aiJobId: "setup",
    });
    expect(
      await canStartAiOperation(userId, {
        operation: "image.generate",
        model: modelId,
      }),
    ).toBe(true);
    const reservation = await createReservedAiJob({
      userId,
      kind: "image",
      provider: "openrouter",
      status: "running",
      usagePercent: 20,
      model: modelId,
    });
    expect(reservation.ok).toBe(true);
    if (reservation.ok) expect(reservation.job.reservedUsageUnits).toBe(0.12);
  });
});
