import { PRO_PLAN } from "@beutl/api";
import type { BillingProduct } from "@/lib/billing-product";
import { getExpandableId, hasStripeOwnerMetadata } from "./ownership";
import type Stripe from "stripe";

type BillingDocumentStripeClient = {
  invoices: Pick<Stripe.InvoicesResource, "list">;
  charges: Pick<Stripe.ChargesResource, "list">;
};

// Stripe が 1 ページで返す上限。月次請求なら 100 件で 8 年分あり、それより古い
// 支払いに書類のリンクが付かないだけなので、ページングは追わない。
const STRIPE_PAGE_LIMIT = 100;

export type BillingDocumentLink = {
  url: string;
  // 請求書と領収書は別物なので、リンクの文言を選べるように区別して返す。
  kind: "invoice" | "receipt";
};

export type SubscriptionPaymentRecord = {
  id: string;
  product: BillingProduct;
  paidAt: Date;
  periodStart: Date;
  periodEnd: Date;
  amount: { value: number; currency: string };
  refundedAmount: number;
  disputed: boolean;
  document: BillingDocumentLink | null;
};

export type BillingDocuments = {
  subscriptionPayments: SubscriptionPaymentRecord[];
  documentByPaymentIntentId: ReadonlyMap<string, BillingDocumentLink>;
};

type ChargeSummary = {
  receiptUrl: string | null;
  refundedAmount: number;
  disputed: boolean;
};

function fromUnixSeconds(seconds: number): Date {
  return new Date(seconds * 1000);
}

function summarizeChargesByPaymentIntent(
  charges: readonly Stripe.Charge[],
): Map<string, ChargeSummary> {
  const summaries = new Map<string, ChargeSummary>();
  for (const charge of charges) {
    // 失敗した試行も同じ PaymentIntent にぶら下がる。領収書も返金額も成立した
    // 支払いのものだけが意味を持つ。
    if (charge.status !== "succeeded") continue;
    const paymentIntentId = getExpandableId(charge.payment_intent);
    if (!paymentIntentId) continue;
    const existing = summaries.get(paymentIntentId);
    summaries.set(paymentIntentId, {
      receiptUrl: existing?.receiptUrl ?? charge.receipt_url,
      refundedAmount: (existing?.refundedAmount ?? 0) + charge.amount_refunded,
      disputed: (existing?.disputed ?? false) || charge.disputed,
    });
  }
  return summaries;
}

function paidPaymentIntentIds(invoice: Stripe.Invoice): string[] {
  const ids: string[] = [];
  for (const payment of invoice.payments?.data ?? []) {
    if (payment.status !== "paid") continue;
    const paymentIntentId = getExpandableId(payment.payment.payment_intent);
    if (paymentIntentId) ids.push(paymentIntentId);
  }
  return ids;
}

// 定期請求の初回請求書は period_start と period_end が同じ瞬間になり、実際に
// 利用できる期間は明細行だけが持っている。
function servicePeriod(invoice: Stripe.Invoice): { start: Date; end: Date } {
  let start = invoice.period_start;
  let end = invoice.period_end;
  for (const line of invoice.lines.data) {
    if (!line.period) continue;
    start = Math.min(start, line.period.start);
    end = Math.max(end, line.period.end);
  }
  return { start: fromUnixSeconds(start), end: fromUnixSeconds(end) };
}

// この請求書がこのアプリの Pro サブスクリプションのものか。顧客 ID は呼び出し側で
// ユーザーに紐づけて解決済みだが、他所で作られた契約を Beutl の商品名で出さない
// ために、契約側のメタデータも確かめる。
function isOwnedProSubscriptionInvoice(
  invoice: Stripe.Invoice,
  userId: string,
): boolean {
  const details = invoice.parent?.subscription_details;
  return (
    details != null &&
    details.metadata?.planId === PRO_PLAN.id &&
    hasStripeOwnerMetadata(details.metadata, userId)
  );
}

export async function retrieveBillingDocuments({
  stripe,
  customerId,
  userId,
}: {
  stripe: BillingDocumentStripeClient;
  customerId: string;
  userId: string;
}): Promise<BillingDocuments> {
  const [invoices, charges] = await Promise.all([
    stripe.invoices.list({
      customer: customerId,
      limit: STRIPE_PAGE_LIMIT,
      expand: ["data.payments"],
    }),
    stripe.charges.list({ customer: customerId, limit: STRIPE_PAGE_LIMIT }),
  ]);

  const chargeSummaries = summarizeChargesByPaymentIntent(charges.data);
  const documentByPaymentIntentId = new Map<string, BillingDocumentLink>();
  const subscriptionPayments: SubscriptionPaymentRecord[] = [];

  for (const invoice of invoices.data) {
    const paymentIntentIds = paidPaymentIntentIds(invoice);
    const invoiceUrl = invoice.hosted_invoice_url;
    if (invoiceUrl) {
      for (const paymentIntentId of paymentIntentIds) {
        documentByPaymentIntentId.set(paymentIntentId, {
          url: invoiceUrl,
          kind: "invoice",
        });
      }
    }

    if (
      invoice.status !== "paid" ||
      invoice.amount_paid <= 0 ||
      !isOwnedProSubscriptionInvoice(invoice, userId)
    ) {
      continue;
    }
    const period = servicePeriod(invoice);
    const summaries = paymentIntentIds
      .map((id) => chargeSummaries.get(id))
      .filter((summary): summary is ChargeSummary => summary !== undefined);
    subscriptionPayments.push({
      id: invoice.id,
      product: "aiPro",
      paidAt: fromUnixSeconds(
        invoice.status_transitions.paid_at ?? invoice.created,
      ),
      periodStart: period.start,
      periodEnd: period.end,
      amount: { value: invoice.amount_paid, currency: invoice.currency },
      refundedAmount: summaries.reduce(
        (total, summary) => total + summary.refundedAmount,
        0,
      ),
      disputed: summaries.some((summary) => summary.disputed),
      document: invoiceUrl ? { url: invoiceUrl, kind: "invoice" } : null,
    });
  }

  // 請求書のない単発の支払いは Stripe の領収書が唯一の控えになる。請求書を
  // 持っている支払いは上で入っているので、ここでは上書きしない。
  for (const [paymentIntentId, summary] of chargeSummaries) {
    if (!summary.receiptUrl || documentByPaymentIntentId.has(paymentIntentId)) {
      continue;
    }
    documentByPaymentIntentId.set(paymentIntentId, {
      url: summary.receiptUrl,
      kind: "receipt",
    });
  }

  return { subscriptionPayments, documentByPaymentIntentId };
}
