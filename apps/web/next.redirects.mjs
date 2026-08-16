// ストレージ / ライブラリ / 開発者向け / アカウント設定を /dashboard 配下へ移した
// ときの旧 URL 互換。契約テストから読めるよう、副作用のない純データとして持つ。
//
// 特に /account/manage/email と /account/manage/personal-data/handle は送信済みの
// 確認メールに埋まっている。ConfirmationToken.expires を過ぎるまで外さないこと。
const MOVED = [
  ["/storage/:path*", "/dashboard/storage/:path*"],
  ["/library/:path*", "/dashboard/library/:path*"],
  ["/developer/:path*", "/dashboard/developer/:path*"],
  ["/account/manage/:path*", "/dashboard/account/:path*"],
];

/**
 * @returns {{ source: string, destination: string, permanent: boolean }[]}
 */
export function dashboardRedirects() {
  // redirects() は localeMiddleware より先に走る (OpenNext の routingHandler も
  // handleRedirects → handleMiddleware の順)。既定ロケール (ja) は rewrite なので
  // 接頭辞なしで届き、それ以外は接頭辞付きで届くため、両方を明示的に列挙する。
  //
  // permanent: false (307) にしてある。ダッシュボード配下は認証必須で SEO 価値が
  // なく、308 をブラウザにキャッシュさせると一回性 URL の挙動を後から変えられない。
  return MOVED.flatMap(([source, destination]) => [
    { source, destination, permanent: false },
    {
      source: `/:lang(ja|en)${source}`,
      destination: `/:lang${destination}`,
      permanent: false,
    },
  ]);
}
