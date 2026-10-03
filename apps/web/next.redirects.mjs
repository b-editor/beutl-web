// ストレージ / ライブラリ / 開発者向け / アカウント設定を /dashboard 配下へ移した
// ときの旧 URL 互換。契約テストから読めるよう、副作用のない純データとして持つ。
//
// 特に /account/manage/email と /account/manage/personal-data/handle は送信済みの
// 確認メールに埋まっている。ConfirmationToken.expires を過ぎるまで外さないこと。
// AI プランの画面は請求ページへ統合された。このパスは main に存在したことがなく、
// 旧 URL を success_url に持つ Stripe セッションは本番には無い。それでも残すのは、
// このブランチの途中のコミットをデプロイしてから進めた場合に、決済直後の戻り先が
// 404 になるのを避けるため。
const MOVED = [
  ["/storage/:path*", "/dashboard/storage/:path*"],
  ["/library/:path*", "/dashboard/library/:path*"],
  ["/developer/:path*", "/dashboard/developer/:path*"],
  ["/dashboard/account/ai-plan", "/dashboard/account/billing"],
  ["/account/manage/:path*", "/dashboard/account/:path*"],
];

const LANGUAGES = ["ja", "en"];

/**
 * @returns {{ source: string, destination: string, permanent: boolean }[]}
 */
export function dashboardRedirects() {
  // redirects() は localeMiddleware より先に走る (Next.js の実行順で、vinext も
  // 同じ順に処理する)。既定ロケール (ja) は rewrite なので
  // 接頭辞なしで届き、それ以外は接頭辞付きで届くため、両方を明示的に列挙する。
  //
  // 接頭辞は `/:lang(ja|en)` でまとめず、言語ごとに書き出す。vinext 1.0.1 は
  // `/:lang(ja|en)/...` の後半を固定文字列とみなし、`:path*` を含む後半と照合
  // できない (/en/storage/files が 404 になる)。
  //
  // permanent: false (307) にしてある。ダッシュボード配下は認証必須で SEO 価値が
  // なく、308 をブラウザにキャッシュさせると一回性 URL の挙動を後から変えられない。
  return MOVED.flatMap(([source, destination]) => [
    { source, destination, permanent: false },
    ...LANGUAGES.map((lang) => ({
      source: `/${lang}${source}`,
      destination: `/${lang}${destination}`,
      permanent: false,
    })),
  ]);
}
