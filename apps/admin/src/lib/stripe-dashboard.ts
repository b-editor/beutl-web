import "server-only";

// Stripe ダッシュボードはテストモードのオブジェクトを /test 配下で開く。
// どちらのモードかは、この環境が使っている API キーの接頭辞で決まる。
export function stripeDashboardUrl(path: string): string {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const testMode = /^(sk|rk)_test_/.test(key);
  return `https://dashboard.stripe.com${testMode ? "/test" : ""}/${path.replace(/^\//, "")}`;
}
