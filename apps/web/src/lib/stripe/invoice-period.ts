import type Stripe from "stripe";

// 定期請求の初回請求書は period_start と period_end が同じ瞬間になり、実際に
// 利用できる期間は明細行だけが持っている。トップレベルだけを読むと初回請求は
// 「期間のない請求」に見えてしまうため、明細行まで含めて最も広い範囲を取る。
export function invoiceServicePeriodSeconds(
  invoice: Stripe.Invoice,
): { start: number; end: number } {
  let start = invoice.period_start;
  let end = invoice.period_end;
  // 明細を展開していない請求書オブジェクトもあるので、無ければトップレベルだけで読む。
  for (const line of invoice.lines?.data ?? []) {
    if (!line.period) continue;
    start = Math.min(start, line.period.start);
    end = Math.max(end, line.period.end);
  }
  return { start, end };
}

// 返金・チャージバックを紐づけられる期間として使えるときだけ返す。使えない値を
// そのまま通すと、利用権の停止期間が過去や 0 秒になってしまう。
export function resolveInvoiceServicePeriod(
  invoice: Stripe.Invoice,
): { start: Date; end: Date } | null {
  const { start, end } = invoiceServicePeriodSeconds(invoice);
  if (!Number.isSafeInteger(start) || start < 0) return null;
  if (!Number.isSafeInteger(end) || end < 0) return null;
  if (start >= end) return null;
  return { start: new Date(start * 1_000), end: new Date(end * 1_000) };
}
