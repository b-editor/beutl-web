import { describe, expect, it } from "vitest";
import { getAiPlanPresentation } from "../../apps/web/src/lib/ai-plan-presentation";

describe("AI plan presentation", () => {
  const now = new Date("2026-08-12T00:00:00.000Z");

  it("keeps the portal path while a cancellation is still effective", () => {
    expect(
      getAiPlanPresentation(
        {
          canUseAi: true,
          subscriptionStatus: "active",
          cancelAtPeriodEnd: true,
          currentPeriodEnd: "2026-08-20T00:00:00.000Z",
        },
        now,
      ),
    ).toEqual({
      status: "cancelScheduled",
      canManageSubscription: true,
      showCurrentPeriodEnd: true,
      showCancellationNotice: true,
    });
  });

  it("offers a new subscription after a scheduled cancellation has elapsed before its webhook", () => {
    expect(
      getAiPlanPresentation(
        {
          canUseAi: false,
          subscriptionStatus: "active",
          cancelAtPeriodEnd: true,
          currentPeriodEnd: "2026-08-11T23:59:59.000Z",
        },
        now,
      ),
    ).toEqual({
      status: "canceled",
      canManageSubscription: false,
      showCurrentPeriodEnd: false,
      showCancellationNotice: false,
    });
  });

  it("keeps non-cancellation payment states on the management path", () => {
    expect(
      getAiPlanPresentation(
        {
          canUseAi: false,
          subscriptionStatus: "past_due",
          cancelAtPeriodEnd: false,
          currentPeriodEnd: "2026-08-11T23:59:59.000Z",
        },
        now,
      ),
    ).toMatchObject({
      status: "needsAttention",
      canManageSubscription: true,
    });
  });
});
