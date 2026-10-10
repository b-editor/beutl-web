import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createStripeClient } from "../../packages/api/src/stripe-client";

const apiRequire = createRequire(new URL("../../packages/api/package.json", import.meta.url));
const Stripe = apiRequire("stripe");

describe("Stripe SDK wire compatibility", () => {
  it("keeps the billing API version and sends expiry idempotency as a header", async () => {
    const requests: Array<{ url: string; headers: Headers; body: string }> = [];
    const stripe = createStripeClient("sk_test_dependency_probe", {
      httpClient: Stripe.createFetchHttpClient(async (url: string, init: RequestInit) => {
        requests.push({ url, headers: new Headers(init.headers), body: String(init.body ?? "") });
        return new Response(JSON.stringify({ id: "cs_probe", object: "checkout.session", status: "expired", payment_status: "unpaid" }), {
          headers: { "content-type": "application/json" },
        });
      }),
    });
    const session = await stripe.checkout.sessions.expire("cs_probe", {}, {
      idempotencyKey: "beutl:expiry:probe",
    });
    expect(session.status).toBe("expired");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.stripe.com/v1/checkout/sessions/cs_probe/expire");
    expect(requests[0].headers.get("Stripe-Version")).toBe("2026-02-25.clover");
    expect(requests[0].headers.get("Idempotency-Key")).toBe("beutl:expiry:probe");
    expect(requests[0].body).toBe("");
  });

  it("continues to verify existing-format webhook payloads and rejects modified ones", () => {
    const stripe = createStripeClient("sk_test_dependency_probe");
    const secret = "whsec_dependency_probe";
    const payload = JSON.stringify({ id: "evt_probe", object: "event", type: "checkout.session.completed", api_version: "2026-02-25.clover", data: { object: { id: "cs_probe", object: "checkout.session" } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect(stripe.webhooks.constructEvent(payload, signature, secret).api_version).toBe("2026-02-25.clover");
    expect(() => stripe.webhooks.constructEvent(payload.replace("cs_probe", "cs_modified"), signature, secret)).toThrow();
  });
});
