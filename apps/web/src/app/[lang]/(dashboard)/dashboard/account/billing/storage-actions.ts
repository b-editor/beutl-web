"use server";

// Server actions for the storage plan. Everything plan-agnostic lives in
// subscription-checkout.ts; this module only picks the tier from the form and
// adds the storage-specific rule that a downgrade may not drop below the
// current usage.
import { throwIfUnauth } from "@/lib/auth-guard";
import { createOrRetrieveOwnedCustomerId } from "@/lib/customer";
import { createStripe } from "@/lib/stripe/config";
import {
  changeSubscriptionTier,
  createSubscriptionCancelPortalLink,
  createSubscriptionCheckout,
  reconcileSubscriptionCheckoutSuccess,
} from "@/lib/stripe/subscription-checkout";
import { subscriptionPlanConfig } from "@/lib/stripe/subscription-plans";
import { isStorageTierId, storageTierOf, type StorageTierId } from "@beutl/core";
import { sumFileSizeByUserId } from "@beutl/db";
import { redirect } from "next/navigation";

const BILLING_PATH = "/dashboard/account/billing";

function tierFromForm(formData: FormData): StorageTierId | null {
  const tier = formData.get("tier");
  return isStorageTierId(tier) ? tier : null;
}

export async function createStorageCheckout(formData: FormData): Promise<void> {
  const session = await throwIfUnauth();
  const tier = tierFromForm(formData);
  if (!tier) redirect(BILLING_PATH);
  const customerId = await createOrRetrieveOwnedCustomerId({
    email: session.user.email as string,
    userId: session.user.id,
  });
  await createSubscriptionCheckout({
    stripe: createStripe(),
    plan: subscriptionPlanConfig("storage"),
    tier,
    userId: session.user.id,
    customerId,
  });
}

export async function reconcileStorageCheckoutSuccess(
  stripeCheckoutSessionId: string,
): Promise<boolean> {
  const session = await throwIfUnauth();
  return await reconcileSubscriptionCheckoutSuccess({
    stripe: createStripe(),
    plan: subscriptionPlanConfig("storage"),
    userId: session.user.id,
    stripeCheckoutSessionId,
  });
}

// Downgrading below the current usage is refused so the account does not land
// in the over-quota state on purpose.
export async function changeStorageTier(formData: FormData): Promise<void> {
  const session = await throwIfUnauth();
  const tier = tierFromForm(formData);
  if (!tier) redirect(BILLING_PATH);
  const userId = session.user.id;
  const outcome = await changeSubscriptionTier({
    stripe: createStripe(),
    plan: subscriptionPlanConfig("storage"),
    tier,
    userId,
    canChange: async (from, to) => {
      if (!isStorageTierId(from) || !isStorageTierId(to)) return true;
      const target = storageTierOf(to);
      if (target.quotaBytes >= storageTierOf(from).quotaBytes) return true;
      const usedBytes = await sumFileSizeByUserId({ userId });
      return usedBytes <= BigInt(target.quotaBytes);
    },
  });
  switch (outcome) {
    case "changed":
      redirect(`${BILLING_PATH}?portal=returned&tier=changed`);
    case "blocked":
      redirect(`${BILLING_PATH}?tier=over-quota`);
    case "payment-failed":
    case "not-active":
      redirect(`${BILLING_PATH}?tier=failed`);
    default:
      redirect(BILLING_PATH);
  }
}

export async function createStorageCancelPortalLink(): Promise<void> {
  const session = await throwIfUnauth();
  const customerId = await createOrRetrieveOwnedCustomerId({
    email: session.user.email as string,
    userId: session.user.id,
  });
  const url = await createSubscriptionCancelPortalLink({
    stripe: createStripe(),
    plan: subscriptionPlanConfig("storage"),
    userId: session.user.id,
    customerId,
  });
  redirect(url ?? BILLING_PATH);
}
