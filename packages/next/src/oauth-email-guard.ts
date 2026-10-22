// better-auth の user.validateUserInfo ゲート。OAuth プロバイダが返した
// emailVerified を provider 別に検査する。
//
// なぜ GitHub を implicit linking の trustedProviders に入れられないか:
// GitHub のアカウントは任意のメールアドレスを「未検証のまま」追加できる。
// プロバイダは primary が未検証なら unverified email を選んでもおかしくない
// (better-auth の GitHub provider は `emails.find(primary) ?? emails[0]` を採用
// する)。つまり GitHub が返す email はアドレスの所有証明として扱えない。
// そのまま trustedProviders に入れると、攻撃者が被害者のメールアドレスを自分の
// GitHub に追加して OAuth サインインするだけで、そのアカウントが被害者の
// 既存ユーザーに紐付けられ、以後 GitHub サインインで被害者として入れる
// (アカウント乗っ取り)。被害者が管理者でも同一経路で乗っ取られる。
//
// このゲートは create-user / link-account / sign-in の 3 経路すべてで
// GitHub 特有の拒否を敷く:
//   - create-user: 未検証メールの GitHub プロフィールでのユーザー作成を拒否し、
//     「先に他人のメールでアカウントを取っておく」事前取り込みも封じる
//   - link-account: 未検証メールの紐付けを拒否する (trustedProviders からの
//     github 除外と重複した defense in depth)
//   - sign-in: 旧設定で紐付けられてしまった既存リンクの再サインインも拒否する
//
// Google は consumer アカウントなら常に email_verified: true を署名付き
// id_token で返し、RP を装った偽物は OIDC の署名検証で除外できるため、
// ここでは検査しない。SSO も未使用なので対象外。magic link はサイト側で
// メールの到達性を検証済み (emailVerified: true で作られる) ため対象外。
//
// better-auth が期待する型 (ValidateUserInfoSource / ValidateUserInfoResult)
// は @better-auth/core の公開型と構造的に一致させる。packages/next から
// @better-auth/core を直接 import すると pnpm の依存解決から外れるため、
// ここでは最小限のローカル型で受ける。
// 指摘時の生成物: {[error, errorDescription]} を返すと better-auth が
// FORBIDDEN を投げ、callback はエラーページへリダイレクトする。

type OAuthEmailOwnershipGateData = {
  user: {
    emailVerified?: unknown;
    id?: unknown;
  } & Record<string, unknown>;
  source: {
    action?: string;
    method?: string;
    oauth?: {
      providerId?: unknown;
      profile?: unknown;
    };
  };
};

export function oauthEmailOwnershipGate({
  user,
  source,
}: OAuthEmailOwnershipGateData): {
  error: string;
  errorDescription?: string;
} | undefined {
  if (source.method !== "oauth") return undefined;
  if (source.oauth?.providerId !== "github") return undefined;
  // 欠損している場合も未検証として扱う (fail-closed)。
  if (user.emailVerified === true) return undefined;

  console.error(
    "GitHub OAuth rejected: the provider claims an email address it has not verified",
    {
      action: source.action,
      userId: typeof user.id === "string" ? user.id : undefined,
      // メールアドレス自体は出力しない。
    },
  );
  return {
    error: "githubEmailNotVerified",
    errorDescription:
      "This GitHub email address is not verified on GitHub. Verify it on GitHub first, then sign in again.",
  };
}
