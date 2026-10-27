// 各アプリの middleware がページ応答に付けるセキュリティヘッダー。
//
// middleware の matcher (各アプリで宣言) は _next と api/ を除外する。この関数は
// matcher を通る応答、つまり HTML ドキュメント (localeMiddleware の redirect /
// rewrite / next のどれでも) にヘッダーを上書きなしで追加する。応答が既に同名の
// ヘッダーを持っていれば尊重する。重複したヘッダー値はブラウザ側で連結され、
// 単一トークンしか受け付けない X-Frame-Options などの意味が失われるため。
//
// なぜ middleware でスクリプトの nonce を使わないか:
// middleware の nonce CSP は「都度レンダーするページ」でしか成立しない。Next は
// store / docs など静的なページをビルド時に固め、OpenNext がその HTML を R2 の
// incremental cache に置く。キャッシュされた HTML のインラインスクリプトはその
// レンダー時点の nonce を運ぶが、ビルド時のリクエストには CSP が存在しない
// (nonce を取れる場所がない)。リクエストごとの新しい nonce はキャッシュ済みの
// HTML を殺す。そこで script-src は 'unsafe-inline' を許す。
// それでも CSP は残りの面 (frame-ancestors, object-src, base-uri, form-action,
// connect/img/media/font-src の下限) を強制する。
//
// 'unsafe-inline' が割に合う前提:
//   - Next.js App Router は複数の inline bootstrap script を書き出す。全員 chunk
//     ('self') と一体として走る
//   - アプリ内に <script> タグ / 第三者スクリプト / iframe は置かない運用
//   - React の style プロパティは style 属性として書かれる。style-hash の維持は
//     現実的でないため style-src 'unsafe-inline' とする
// 第三者スクリプトを追加する時点でこの前提は破れる。その時は CSP の全面見直しを
// 伴うこと。
//
// img-src 'self' https: data: の https: は markdown 本文 (react-markdown が書き出す
// 任意の img) と GitHub / Google のアバターを受け入れるための軟和策。外部画像の
// 参照は失敗しうるが、スクリプトの実行経路にはなりえない。監査では「markdown の
// img で任意 URL を参照できる」件の緩和策として提案済み。
//
// dev のみ 'unsafe-eval' を script-src に足す。webpack の HMR と React refresh は
// eval を使う。OpenNext のワーカーは production ビルドで動くため本番では出ない。
// 同一ポリシー内で script-src を二度書くと最初の一度しか採用されないため、
// script-src はここで差し込む (DIRECTIVES の外に置く)。

export type SecurityEnvironment = {
  NODE_ENV?: string | undefined;
  /** Public origin of the S3 endpoint, allowed for direct multipart PUTs. */
  STORAGE_ORIGIN?: string | undefined;
  /** Same-origin WebSocket endpoint used by a page, with an explicit ws(s) scheme. */
  WEBSOCKET_ORIGIN?: string | undefined;
};

const DIRECTIVES = [
  "default-src 'self'",
  // script-src は contentSecurityPolicy() で差し込む (上の注記を参照)。
  "style-src 'self' 'unsafe-inline'",
  // markdown の img とプロバイダのアバターに https: を残す (理由は冒頭)。
  // blob: は AI 面のローカルファイルのプレビュー (URL.createObjectURL) 用。
  "img-src 'self' https: data: blob:",
  // next/font/google はビルド時にフォントを自己ホストする。
  "font-src 'self'",
  // blob: は動画/音声のプレビューと、モデルの入力制限を判定するメタデータ取得
  // (ai-video-duration.ts / audio-extract.ts が video 要素に createObjectURL を
  // 渡す) 用。無いと有効な入力が「読み取れないもの」として投稿が拒否される。
  "media-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  // form-action はフォーム送信のリダイレクト先にも適用される (Chromium の
  // 挙動: ネイティブ送信の 303 に対して再検査される)。ハイドレーション前でも
  // 送れる課金フォーム (billing/components.tsx の <form action={...}>) は
  // Stripe Checkout と請求ポータルへ 303 するので、その 2 オリジンを許す。
  // ストア購入は GET 遷移 (form でない) なので対象外。
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
];

export function contentSecurityPolicy({
  NODE_ENV = "production",
  STORAGE_ORIGIN,
  WEBSOCKET_ORIGIN,
}: SecurityEnvironment = {}): string {
  // static.cloudflareinsights.com は Cloudflare の Web Analytics (RUM) のビーコン。
  // ゾーン設定でエッジから HTML に注入されるためコード側では出せない。許可しないと
  // 計測が死ぬ。
  const scriptSrc =
    NODE_ENV === "development"
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com";
  // cloudflareinsights.com は RUM ビーコンが計測値を POST する先。
  // STORAGE_ORIGIN は presigned でブラウザから直接 PUT する S3 のオリジン。
  const connectSrc = [
    "'self'",
    "https://cloudflareinsights.com",
    ...(STORAGE_ORIGIN ? [STORAGE_ORIGIN] : []),
    ...(WEBSOCKET_ORIGIN ? [WEBSOCKET_ORIGIN] : []),
  ].join(" ");
  return [DIRECTIVES[0], scriptSrc, ...DIRECTIVES.slice(1), `connect-src ${connectSrc}`].join("; ");
}

export function securityHeaders({
  NODE_ENV = "production",
  STORAGE_ORIGIN,
  WEBSOCKET_ORIGIN,
}: SecurityEnvironment = {}): Readonly<Record<string, string>> {
  return {
    "Content-Security-Policy": contentSecurityPolicy({ NODE_ENV, STORAGE_ORIGIN, WEBSOCKET_ORIGIN }),
    // サイトはすべて Cloudflare の HTTPS (カスタムドメイン) で配信され、
    // サブドメイン (admin.beutl.beditor.net) も HTTPS のため includeSubDomains は
    // 安全。preload は HSTS preload リストへの登録 (抜け出すのが難しい) を伴う
    // ため、このヘッダーには含めない。登録するかは運用判断で。
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    // frame-ancestors 'none' の旧来の代替 (CSP を理解しないブラウザ向け)。
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // OAuth は全画面遷移、Server Action も同オリジン。window.open の利用箇所は
    // すべて noopener,noreferrer を付けているため、same-origin で壊れない。
    "Cross-Origin-Opener-Policy": "same-origin",
    // メディア録取の利用は無いが制限しておく (必要が生じた時点で緩める)。
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

const HEADER_NAMES = [
  "Content-Security-Policy",
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Referrer-Policy",
  "Cross-Origin-Opener-Policy",
  "Permissions-Policy",
] as const;

// 与えられた応答にヘッダーを加える。既に存在する値はそのまま (上書きしない)。
// 自前でヘッダーを付ける応答 (ダウンロードの strict CSP や 413) も壊さない。
export function applySecurityHeaders<
  T extends Response,
>(response: T, env: SecurityEnvironment = process.env): T {
  const headers = securityHeaders(env);
  for (const name of HEADER_NAMES) {
    if (!response.headers.has(name)) {
      response.headers.set(name, headers[name]);
    }
  }
  return response;
}
