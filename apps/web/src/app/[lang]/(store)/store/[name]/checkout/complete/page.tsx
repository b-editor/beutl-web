import { authOrSignIn } from "@/lib/auth-guard";
import { createStripe } from "@/lib/stripe/config";
import { isOwnedPackagePaymentIntent } from "@/lib/stripe/store-checkout";
import { ClientPage } from "./components";
import { notFound } from "next/navigation";
import { PackageDetails } from "../components";
import { retrievePackage } from "@/lib/store-utils";
import {
  findCustomerByUserId,
  findPackagePaymentReference,
} from "@beutl/db";
import { resolvePackageCheckoutCompletionStatus } from "./status";

export default async function Page(
  props: {
    params: Promise<{ name: string; lang: string }>;
    searchParams: Promise<{
      payment_intent?: string | string[];
    }>;
  }
) {
  const searchParams = await props.searchParams;

  const {
    payment_intent
  } = searchParams;

  const params = await props.params;

  const {
    name,
    lang
  } = params;

  const session = await authOrSignIn();
  const pkg = await retrievePackage(name);
  if (!pkg || typeof payment_intent !== "string" || !payment_intent) {
    notFound();
  }

  const stripe = createStripe();
  const intent = await stripe.paymentIntents.retrieve(payment_intent);
  const customer = await findCustomerByUserId({ userId: session.user.id });
  if (
    !customer ||
    !isOwnedPackagePaymentIntent(intent, {
      customerId: customer.stripeId,
      userId: session.user.id,
      packageId: pkg.id,
    })
  ) {
    notFound();
  }
  const payment = await findPackagePaymentReference({
    paymentId: intent.id,
  });
  const status = resolvePackageCheckoutCompletionStatus(
    intent.status,
    payment,
  );

  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 px-2 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <div className="max-sm:relative flex max-md:flex-col gap-2">
        <div className="md:flex-1 mx-3 min-w-0">
          <PackageDetails
            pkg={pkg}
            price={intent.amount}
            currency={intent.currency}
            lang={lang}
          />
        </div>
        <div className="border max-md:h-[1px] md:w-[1px]" />
        <div className="md:flex-1 mx-2 max-md:mt-4">
          <ClientPage status={status} name={name} lang={lang} />
        </div>
      </div>
    </div>
  );
}
