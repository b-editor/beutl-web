import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: { user: { id: "admin-1" } },
  addAuditLog: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({
  adminAction: async (fnc: (session: unknown) => Promise<unknown>) => await fnc(mocks.session),
}));
vi.mock("@beutl/next/audit-log", async () => ({
  addAuditLog: mocks.addAuditLog,
  auditLogActions: (await import("../../packages/db/src/audit-log")).auditLogActions,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
// users/[id]/actions.ts は削除やクレジット調整のために Stripe と課金の依存を持つ。
// ここで検証するのは付与だけなので、読み込みだけ通す。
vi.mock("@beutl/api", () => ({}));
vi.mock("stripe", () => ({ default: class {} }));

import { addUtcMonths } from "@beutl/core";
import { setDbProvider } from "@beutl/db";
import {
  grantSubscription,
  revokeGrantedSubscription,
} from "../../apps/admin/src/app/[lang]/admin/users/[id]/actions";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER_ID = "granted-user";
const DAY = 24 * 60 * 60 * 1_000;

describe("administrator subscription grants", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    memory = createInMemoryPrisma();
    memory.state.users.add(USER_ID);
    setDbProvider(async () => memory.prisma as never);
  });

  const storedGrants = () => [...memory.state.subscriptionGrants.values()];

  it("grants a plan for whole months from now and records it", async () => {
    const before = Date.now();
    await expect(
      grantSubscription({
        userId: USER_ID,
        planId: "storage",
        tier: "1tb",
        term: { kind: "months", months: 3 },
        reason: "  Beta tester  ",
      }),
    ).resolves.toEqual({ success: true });

    const [grant] = storedGrants();
    expect(grant).toMatchObject({
      userId: USER_ID,
      planId: "storage",
      tier: "1tb",
      reason: "Beta tester",
      grantedByUserId: "admin-1",
    });
    expect(grant.startsAt.getTime()).toBeGreaterThanOrEqual(before);
    // Ending on a period boundary leaves no short period at the end.
    expect(grant.endsAt).toEqual(addUtcMonths(grant.startsAt, 3));
    expect(mocks.addAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "admin.subscriptionGranted",
        details: expect.stringContaining(`grantId: ${grant.id}`),
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalled();
  });

  it("grants until a date or without an end", async () => {
    const endsAt = new Date(Date.now() + 10 * DAY);
    await expect(
      grantSubscription({
        userId: USER_ID,
        planId: "pro",
        tier: null,
        term: { kind: "until", endsAt: endsAt.toISOString() },
        reason: "Support",
      }),
    ).resolves.toEqual({ success: true });
    await expect(
      grantSubscription({
        userId: USER_ID,
        planId: "storage",
        tier: "100gb",
        term: { kind: "indefinite" },
        reason: "Partner",
      }),
    ).resolves.toEqual({ success: true });

    const byPlan = new Map(storedGrants().map((grant) => [grant.planId, grant]));
    expect(byPlan.get("pro")?.endsAt).toEqual(endsAt);
    expect(byPlan.get("storage")?.endsAt).toBeNull();
  });

  it.each([
    ["an unknown plan", { planId: "enterprise" }, "Invalid plan"],
    ["a blank reason", { reason: "   " }, "Enter a reason"],
    ["a reason that is too long", { reason: "x".repeat(501) }, "Enter a reason"],
    ["zero months", { term: { kind: "months", months: 0 } }, "Invalid grant period"],
    ["a fraction of a month", { term: { kind: "months", months: 1.5 } }, "Invalid grant period"],
    ["more than ten years", { term: { kind: "months", months: 121 } }, "Invalid grant period"],
    [
      "a date in the past",
      { term: { kind: "until", endsAt: new Date(Date.now() - DAY).toISOString() } },
      "Invalid grant period",
    ],
    [
      "a date beyond ten years",
      { term: { kind: "until", endsAt: new Date(Date.now() + 3_700 * DAY).toISOString() } },
      "Invalid grant period",
    ],
    ["an unreadable date", { term: { kind: "until", endsAt: "soon" } }, "Invalid grant period"],
    ["an unknown term", { term: { kind: "forever" } }, "Invalid grant period"],
    ["a tier the plan does not have", { tier: "1tb" }, "Invalid tier for this plan"],
  ])("refuses %s", async (_label, overrides, message) => {
    const result = await grantSubscription({
      userId: USER_ID,
      planId: "pro",
      tier: null,
      term: { kind: "months", months: 1 },
      reason: "Beta tester",
      ...(overrides as object),
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain(message);
    expect(storedGrants()).toHaveLength(0);
    expect(mocks.addAuditLog).not.toHaveBeenCalled();
  });

  it("explains why a second grant or a paying user is refused", async () => {
    await grantSubscription({
      userId: USER_ID,
      planId: "pro",
      tier: null,
      term: { kind: "indefinite" },
      reason: "Beta tester",
    });
    vi.clearAllMocks();
    await expect(
      grantSubscription({
        userId: USER_ID,
        planId: "pro",
        tier: null,
        term: { kind: "months", months: 1 },
        reason: "Again",
      }),
    ).resolves.toEqual({
      success: false,
      message: expect.stringContaining("Revoke it before granting again"),
    });

    memory.state.subscriptions.set(`${USER_ID}:storage`, {
      userId: USER_ID,
      stripeSubscriptionId: "sub_storage",
      status: "active",
      planId: "storage",
      tier: "100gb",
      billingOfferId: "offer_storage",
      currentPeriodStart: new Date(Date.now() - DAY),
      currentPeriodEnd: new Date(Date.now() + 29 * DAY),
      cancelAtPeriodEnd: false,
      cancelAt: null,
      stripeEventId: null,
      stripeEventCreatedAt: null,
      stripeCanonicalObservedAt: null,
      stripeObservationRank: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      grantSubscription({
        userId: USER_ID,
        planId: "storage",
        tier: "1tb",
        term: { kind: "months", months: 1 },
        reason: "Upgrade",
      }),
    ).resolves.toEqual({
      success: false,
      message: expect.stringContaining("Cancel it before granting the plan"),
    });
    expect(mocks.addAuditLog).not.toHaveBeenCalled();
  });

  it("revokes a grant in effect once and records it", async () => {
    await grantSubscription({
      userId: USER_ID,
      planId: "pro",
      tier: null,
      term: { kind: "indefinite" },
      reason: "Beta tester",
    });
    const [grant] = storedGrants();
    vi.clearAllMocks();

    await expect(
      revokeGrantedSubscription({ userId: USER_ID, grantId: grant.id }),
    ).resolves.toEqual({ success: true });
    expect(memory.state.subscriptionGrants.get(grant.id)).toMatchObject({
      revokedByUserId: "admin-1",
      revokedAt: expect.any(Date),
    });
    expect(mocks.addAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.subscriptionGrantRevoked" }),
    );

    vi.clearAllMocks();
    await expect(
      revokeGrantedSubscription({ userId: USER_ID, grantId: grant.id }),
    ).resolves.toEqual({
      success: false,
      message: "The grant is no longer in effect",
    });
    expect(mocks.addAuditLog).not.toHaveBeenCalled();
  });
});
