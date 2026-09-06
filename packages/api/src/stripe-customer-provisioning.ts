import Stripe from "stripe";
import {
  beginStripeCustomerProvisioning,
  claimStripeCustomerProvisioning,
  createVerifiedCustomerMappingIfAbsent,
  deleteStripeCustomerProvisioning,
  findAccountDeletionIntentByUserId,
  listDueStripeCustomerProvisioningCleanups,
  markStripeCustomerProvisioningIntervention,
  markStripeCustomerProvisioningCleaned,
  recordStripeCustomerProvisioningRemote,
  rotateStripeCustomerProvisioningKey,
  scheduleStripeCustomerProvisioningCleanup,
  settleStripeCustomerProvisioning,
} from "@beutl/db";

export async function reconcileStripeCustomerProvisioning(
  now = new Date(),
  secretKey = process.env.STRIPE_SECRET_KEY,
  stripeClient?: Pick<Stripe, "customers">,
) {
  if (!stripeClient && !secretKey) return { inspected: 0, settled: 0, cleaned: 0, pending: 0, interventionRequired: 0 };
  const stripe = stripeClient ?? new Stripe(secretKey!);
  const rows = await listDueStripeCustomerProvisioningCleanups({ now });
  let settled = 0;
  let cleaned = 0;
  let pending = 0;
  let interventionRequired = 0;
  for (const row of rows) {
    const leaseToken = crypto.randomUUID();
    const claimed = await claimStripeCustomerProvisioning({ id: row.id, now, leaseToken, leaseExpiresAt: new Date(now.getTime() + 10 * 60_000) });
    if (!claimed) continue;
    try {
      if (!ownerParamsMatch(claimed.paramsJson, claimed.userId)) throw new Error("Customer provisioning owner metadata mismatch");
      let customerId = claimed.stripeCustomerId;
      // A response-lost create has no remote ID even when the row was already
      // marked cleanup_required. Replay the exact current Stripe key first so
      // the unknown remote object is recovered before deciding whether to map
      // or delete it.
      if (!customerId) {
        const customer = await stripe.customers.create(
          JSON.parse(claimed.paramsJson) as Stripe.CustomerCreateParams,
          { idempotencyKey: claimed.stripeIdempotencyKey },
        );
        customerId = customer.id;
        if ((await recordStripeCustomerProvisioningRemote({ id: claimed.id, stripeCustomerId: customerId, leaseToken })).count !== 1) throw new Error("Provisioning lease lost");
      }
      if (!customerId) throw new Error("Customer provisioning has no remote Customer to clean");
      const intent = await findAccountDeletionIntentByUserId({ userId: claimed.userId, now });
      const remote = await stripe.customers.retrieve(customerId);
      if ("deleted" in remote && remote.deleted) {
        if (claimed.status === "cleanup_required" || intent) {
          await markStripeCustomerProvisioningCleaned({ id: claimed.id, leaseToken });
          cleaned++;
          continue;
        }
        const rotated = await rotateStripeCustomerProvisioningKey({ id: claimed.id, leaseToken, stripeIdempotencyKey: `beutl:customer-recovery:${customerId}:${claimed.attempts}` });
        if (rotated.count !== 1) throw new Error("Provisioning recovery key rotation lease lost");
        pending++;
        continue;
      }
      if (remote.metadata?.beutlApplication !== "beutl-web" || remote.metadata.beutlUserId !== claimed.userId) throw new Error("Provisioning remote owner mismatch");
      if (intent || claimed.status === "cleanup_required") {
        try {
          await stripe.customers.del(customerId, {}, { idempotencyKey: `beutl:customer-provisioning-cleanup:${claimed.id}` });
        } catch (error) {
          if (!(error instanceof Stripe.errors.StripeError && error.code === "resource_missing")) throw error;
        }
        if ((await markStripeCustomerProvisioningCleaned({ id: claimed.id, leaseToken })).count !== 1) throw new Error("Provisioning cleanup lease lost");
        cleaned++;
        continue;
      }
      const mapping = await createVerifiedCustomerMappingIfAbsent({ userId: claimed.userId, stripeId: customerId });
      if (mapping.stripeId !== customerId) throw new Error("Customer provisioning mapping conflict");
      if ((await settleStripeCustomerProvisioning({ id: claimed.id, leaseToken })).count !== 1) throw new Error("Provisioning settle lease lost");
      await deleteStripeCustomerProvisioning({ id: claimed.id });
      settled++;
    } catch (error) {
      const lastError = error instanceof Error ? error.message : String(error);
      if (claimed.attempts >= 12) {
        await markStripeCustomerProvisioningIntervention({ id: claimed.id, leaseToken, lastError });
        interventionRequired++;
      } else {
        await scheduleStripeCustomerProvisioningCleanup({ id: claimed.id, leaseToken, lastError, now: new Date(now.getTime() + Math.min(60 * 60_000, 5 * 60_000 * 2 ** Math.min(claimed.attempts, 6))) });
        pending++;
      }
    }
  }
  return { inspected: rows.length, settled, cleaned, pending, interventionRequired };
}

function ownerParamsMatch(paramsJson: string, userId: string): boolean {
  try {
    const params = JSON.parse(paramsJson) as Stripe.CustomerCreateParams;
    const metadata = params.metadata && typeof params.metadata === "object" ? params.metadata : null;
    return metadata?.beutlApplication === "beutl-web" && metadata.beutlUserId === userId;
  } catch {
    return false;
  }
}
