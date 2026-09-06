import Link from "next/link";

const headingClass =
  "mt-10 scroll-m-20 text-2xl font-semibold tracking-tight";
const listClass = "my-6 ml-6 list-disc [&>li]:mt-2";

const rows = [
  ["Seller", "Disclosed without delay upon request."],
  [
    "Person responsible for operations",
    "Disclosed without delay upon request.",
  ],
  ["Address", "Disclosed without delay upon request."],
  ["Telephone number", "Disclosed without delay upon request."],
  ["Email address", "contact@beditor.net"],
  [
    "Prices",
    "Displayed on each product or plan page. The total amount, currency, and billing interval are displayed on the checkout screen before you confirm a purchase.",
  ],
  [
    "Additional costs",
    "You are responsible for internet access charges, data charges, and any other costs required for your environment to access the Service.",
  ],
  ["Payment method", "Credit card through Stripe"],
  [
    "Payment timing",
    "Payment is processed when you complete a purchase. Recurring purchases are charged automatically at the billing interval shown at checkout until canceled.",
  ],
  [
    "Delivery and commencement of service",
    "Downloadable products become available after payment is confirmed. AI subscriptions and additional credits are added to your account after payment is confirmed. Depending on payment-provider notifications, this may take several minutes.",
  ],
] as const;

export function EnglishCommercialTransactionsPage({
  lang,
}: {
  lang: string;
}) {
  return (
    <article className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <h1 className="scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0">
        Disclosure under the Act on Specified Commercial Transactions
      </h1>
      <p className="mt-4 text-sm text-muted-foreground">
        Last updated: September 6, 2026
      </p>

      <div className="my-6 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse">
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <th className="w-56 border px-4 py-3 text-left align-top font-semibold">
                  {label}
                </th>
                <td className="border px-4 py-3 text-left align-top">
                  {value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className={headingClass}>Canceling a recurring purchase</h2>
      <p className="leading-7 not-first:mt-6">
        You may cancel an AI subscription before its next renewal from the
        billing page in your account. After cancellation, you may continue to
        use the applicable features until the end of the current access period
        shown on that page, and the subscription will not renew again. Unless
        required by law or otherwise stated before purchase, canceling during a
        current access period does not entitle you to a prorated refund.
      </p>

      <h2 className={headingClass}>Returns, exchanges, and refunds</h2>
      <p className="leading-7 not-first:mt-6">
        Because the products and online services are digital, we do not accept
        returns, exchanges, or refunds for convenience after a purchase is
        confirmed, except where required by law or permitted by terms displayed
        before purchase.
      </p>
      <ul className={listClass}>
        <li>
          If you cannot download a product normally, or if the product is
          corrupted or materially different from its description, contact
          contact@beditor.net within seven days after purchase. After reviewing
          the circumstances, we will provide a reasonable remedy such as
          redelivery, replacement, or a refund.
        </li>
        <li>
          If we can confirm that an AI operation did not run, we will restore
          the usage allowance or credits reserved or consumed for that
          operation. If the outcome at an external AI provider cannot be
          determined immediately, the allowance may remain reserved until the
          outcome is resolved. Restoring an allowance is not a refund of an AI
          subscription fee or an additional-credit purchase.
        </li>
        <li>
          If a refund, payment reversal, or dispute is completed, we may revoke
          the corresponding product entitlement or credits.
        </li>
      </ul>

      <h2 className={headingClass}>System requirements</h2>
      <ul className={listClass}>
        <li>Windows 10 or later (x64)</li>
        <li>macOS 14.0 or later</li>
        <li>Ubuntu 22.04</li>
      </ul>
      <p className="leading-7 not-first:mt-6">
        A package may have additional requirements. Review its product page and
        included documentation before use.
      </p>

      <h2 className={headingClass}>Other terms</h2>
      <p className="leading-7 not-first:mt-6">
        The
        {" "}
        <Link
          className="underline underline-offset-4 hover:text-primary"
          href={`/${lang}/docs/terms`}
        >
          Terms of Service
        </Link>
        {" "}
        contain additional terms governing purchases, usage allowances,
        published packages, and AI features.
      </p>
    </article>
  );
}
