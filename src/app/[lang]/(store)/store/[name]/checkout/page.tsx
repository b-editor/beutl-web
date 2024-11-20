import { authOrSignIn } from "@/lib/auth-guard";
import { createOrRetrieveCustomerId } from "@/lib/customer";
import { stripe } from "@/lib/stripe/config";
import { ClientPage } from "./components";

export default async function Page({
  searchParams: { payment_intent_client_secret }
}: {
  searchParams: { payment_intent_client_secret?: string }
}) {
  const session = await authOrSignIn();
  const customerId = await createOrRetrieveCustomerId(session.user.email as string, session.user.id);
  const paymentIntent = await stripe.paymentIntents.create({
    customer: customerId,
    setup_future_usage: "off_session",
    amount: 500,
    currency: "jpy",
    // In the latest version of the API, specifying the `automatic_payment_methods` parameter is optional because Stripe enables its functionality by default.
    automatic_payment_methods: {
      enabled: true,
    },
  });

  const clientSecret = paymentIntent.client_secret;
  // [DEV]: For demo purposes only, you should avoid exposing the PaymentIntent ID in the client-side code.
  const dpmCheckerLink = `https://dashboard.stripe.com/settings/payment_methods/review?transaction_id=${paymentIntent.id}`;

  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 pl-4 lg:pl-6 pr-2 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
    {/* <div className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4"> */}
      <div className="max-sm:relative md:flex sm:gap-2">
        <div className="flex-1">

        </div>
        <div className="border w-[1px]" />
        <div className="flex-1">
          <ClientPage clientSecret={clientSecret} dpmCheckerLink={dpmCheckerLink} confirmed={false} />
        </div>
      </div>
    </div>
  )
}