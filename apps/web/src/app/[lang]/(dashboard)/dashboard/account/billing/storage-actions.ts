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
import { SubscriptionOfferUnavailableError } from "@/lib/stripe/subscription-billing";
import { subscriptionPlanConfig } from "@/lib/stripe/subscription-plans";
import { isStorageTierId, storageTierOf, type StorageTierId } from "@beutl/core";
import { sumFileSizeByUserId, sumStorageUploadSizeByUserId } from "@beutl/db";
import { redirect } from "next/navigation";

const BILLING_PATH = "/dashboard/account/billing";

function tierFromForm(formData: FormData): StorageTierId | null {
  const tier = formData.get("tier");
  return isStorageTierId(tier) ? tier : null;
}

// A tier that cannot be sold right now (no Price configured, or the Price
// archived or removed in Stripe since the page was rendered) is answered with
// a notice instead of a server error. The dialog does not offer such a tier,
// but the form field is the client's and Stripe can change underneath.
async function unlessOfferUnavailable<T>(
  run: () => Promise<T>,
  notice: string,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof SubscriptionOfferUnavailableError)) throw error;
  }
  redirect(notice);
}

export async function createStorageCheckout(formData: FormData): Promise<void> {
  const session = await throwIfUnauth();
  const tier = tierFromForm(formData);
  if (!tier) redirect(BILLING_PATH);
  const customerId = await createOrRetrieveOwnedCustomerId({
    email: session.user.email as string,
    userId: session.user.id,
  });
  await unlessOfferUnavailable(
    () =>
      createSubscriptionCheckout({
        stripe: createStripe(),
        plan: subscriptionPlanConfig("storage"),
        tier,
        userId: session.user.id,
        customerId,
      }),
    `${BILLING_PATH}?checkout=unavailable`,
  );
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
// in the over-quota state on purpose. Usage is what the upload paths count:
// completed files plus the bytes reserved by uploads still in flight, so a
// transfer that is already under way is not refused at completion by a
// quota that shrank underneath it. An upload that starts or completes in the
// moment between this check and Stripe's answer is not fenced; the completion
// path re-reads the quota and refuses what no longer fits, and an account
// that lands over quota is treated like a lapsed plan (no new uploads,
// nothing deleted).
export async function changeStorageTier(formData: FormData): Promise<void> {
  const session = await throwIfUnauth();
  const tier = tierFromForm(formData);
  if (!tier) redirect(BILLING_PATH);
  const userId = session.user.id;
  const outcome = await unlessOfferUnavailable(
    () =>
      changeSubscriptionTier({
        stripe: createStripe(),
        plan: subscriptionPlanConfig("storage"),
        tier,
        userId,
        canChange: async (from, to) => {
          if (!isStorageTierId(from) || !isStorageTierId(to)) return true;
          const target = storageTierOf(to);
          if (target.quotaBytes >= storageTierOf(from).quotaBytes) return true;
          const [storedBytes, underwayBytes] = await Promise.all([
            sumFileSizeByUserId({ userId }),
            sumStorageUploadSizeByUserId({ userId }),
          ]);
          return storedBytes + underwayBytes <= BigInt(target.quotaBytes);
        },
      }),
    `${BILLING_PATH}?tier=unavailable`,
  );
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
