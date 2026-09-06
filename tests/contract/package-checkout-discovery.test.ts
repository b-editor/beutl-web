import { describe, expect, it, vi } from "vitest";
import { discoverPackageCheckoutAttempt } from "../../packages/api/src/package-checkout-discovery";

const expected = { customerId: "cus_1", userId: "u1", packageId: "p1", discoveryToken: "a1" };
const session = (id: string, status: "open" | "complete" | "expired") => ({ id, status, mode: "payment", customer: "cus_1", metadata: { beutlApplication: "beutl-web", beutlUserId: "u1", beutlPurchaseKind: "package", packageId: "p1", packageCheckoutAttemptId: "a1" } });

describe("package checkout durable discovery", () => {
  it("paginates every status and returns one exact token match", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ data: [session("open-1", "open")], has_more: true })
      .mockResolvedValueOnce({ data: [], has_more: false })
      .mockResolvedValueOnce({ data: [], has_more: false })
      .mockResolvedValueOnce({ data: [], has_more: false });
    await expect(discoverPackageCheckoutAttempt({ stripe: { checkout: { sessions: { list } } }, expected: { ...expected, createdAt: new Date("2026-08-25T00:00:00Z") } } as never)).resolves.toEqual({ status: "single", session: session("open-1", "open") });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ created: { gte: expect.any(Number) } }));
    expect(list).toHaveBeenCalledTimes(4);
  });

  it("reports multiple exact matches as intervention", async () => {
    const list = vi.fn().mockResolvedValue({ data: [session("a", "open"), session("b", "complete")], has_more: false });
    await expect(discoverPackageCheckoutAttempt({ stripe: { checkout: { sessions: { list } } }, expected } as never)).resolves.toMatchObject({ status: "multiple" });
  });

  it("propagates page failure so caller does not create a new Session", async () => {
    const list = vi.fn().mockRejectedValue(new Error("temporary Stripe list failure"));
    await expect(discoverPackageCheckoutAttempt({ stripe: { checkout: { sessions: { list } } }, expected } as never)).rejects.toThrow("temporary Stripe list failure");
  });
});
