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
// このモジュールは create-user / link-account / sign-in の 3 経路すべてで
// GitHub 特有の拒否を敷く:
//   - create-user: 未検証メールの GitHub プロフィールでのユーザー作成を拒否し、
//     「先に他人のメールでアカウントを取っておく」事前取り込みも封じる
//   - link-account: 未検証メールの紐付けを拒否する (trustedProviders からの
//     github 除外と重複した defense in depth)
//   - sign-in: 紐付け済みアカウントの再サインインも検査する。
//
// sign-in 経路では、紐付け自体が今日の所有証明ルールを満たしているかも確認する。
// better-auth は sign-in を providerId+accountId で解決し、渡されるのは
//provider が返した「最新の」プロフィール (保存行ではない) で、その email が
// 保存中のユーザー email と一致することを要求しない。つまり:
//   (a) GitHub の primary を自分の検証済みメールに差し替えた攻撃者は、
//       emailVerified=true を名乗って旧リンクを通り抜けられる
//   (b) サイト側でメールを変更した正規ユーザーにも差異が生じる
// どちらも「GitHub サインインがこのアカウントの所有を証明できなくなる」ので、
// 差異があれば拒否する。拒否された正規ユーザーは magic link (一次フロー) で
// サインインできる。dashboard の removeAccount で当該紐付けを外せる。
//
// ロールアウト面: validateUserInfo はサインインの試行時にしか動かないため、
// 旧設定 (trustedProviders に github を含めていた期間) で発行されたセッション
// は sign-in 再試行なしでは生き続ける。そこで sign-in 拒否時にそのユーザーの
// 既存セッションとリフレッシュトークン系列を失効させる。攻撃者は拒否で
// 再入できず、持ち越されたセッションも失効して生かせない。ライブな正規
// セッションを持つ被害者は「試行したアカウントの」強制ログアウトを一度受けるが、
// magic link で即時に再ログインできる。
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
// 拒否時の生成物: {error, errorDescription} を返すと better-auth が
// FORBIDDEN を投げ、callback はエラーページへリダイレクトする。

import { getDb, revokeAllUserSessions } from "@beutl/db";

type OAuthEmailOwnershipGateData = {
  user: {
    emailVerified?: unknown;
    email?: unknown;
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

type OAuthEmailOwnershipRejection = {
  error: string;
  errorDescription?: string;
};

const GITHUB_PROVIDER_ID = "github";

function isGitHubOAuthSignIn(
  data: OAuthEmailOwnershipGateData,
): data is OAuthEmailOwnershipGateData & { user: { id: string; email: string } } {
  const { user, source } = data;
  return (
    source.method === "oauth" &&
    source.oauth?.providerId === GITHUB_PROVIDER_ID &&
    source.action === "sign-in" &&
    typeof user.id === "string" &&
    typeof user.email === "string"
  );
}

// 細部をテストから切り離す純粋な判定。プロバイダ email の所有ルール。
export function oauthEmailOwnershipGate({
  user,
  source,
}: OAuthEmailOwnershipGateData): OAuthEmailOwnershipRejection | undefined {
  if (source.method !== "oauth") return undefined;
  if (source.oauth?.providerId !== GITHUB_PROVIDER_ID) return undefined;
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

// better-auth の user.validateUserInfo に差し込む実装。
// 拒否だけでなく、rollout の起点となるセッション失効もここで行う。
export async function enforceOAuthEmailOwnership(
  data: OAuthEmailOwnershipGateData,
): Promise<OAuthEmailOwnershipRejection | undefined> {
  const rejection = oauthEmailOwnershipGate(data);
  if (rejection) {
    // sign-in の拒否は、旧設定で紐付けられたアカウントの再利用か、sign-up
    // 以降に作られた紐付けへの攻撃のどちらかになりうる。いずれにせよ試行した
    // アカウントに持ち越されたセッションが残っていれば取り除く。
    if (data.source.action === "sign-in" && typeof data.user.id === "string") {
      await revokeUserSessionsQuietly(data.user.id);
    }
    return rejection;
  }

  // プロバイダ email が検証済みでも、保存されているアカウント email と
  // 一致しなければ GitHub サインインはこのアカウントの所有を証明しない
  // (旧設定の implicit link が残っているか、サイト側で email を変更した
  // 正規ユーザーかのどちらか)。
  if (!isGitHubOAuthSignIn(data)) return undefined;

  let storedEmail: string | undefined;
  try {
    const db = await getDb();
    const stored = await db.user.findUnique({
      where: { id: data.user.id },
      select: { email: true },
    });
    storedEmail = stored?.email;
  } catch (error) {
    console.error("GitHub sign-in rejected: account email lookup failed", {
      userId: data.user.id,
    }, error);
    return {
      error: "githubEmailLookupUnavailable",
      errorDescription:
        "Sign-in could not verify this GitHub email address. Please try again shortly.",
    };
  }
  if (!storedEmail) {
    // sign-in 経路にユーザー行が無いのは不整合。安全側に倒して拒否する。
    console.error(
      "GitHub sign-in rejected: no local user matching the linked account",
      { userId: data.user.id },
    );
    return {
      error: "githubEmailMismatch",
      errorDescription:
        "This GitHub email address does not match the email on your account. Sign in with a magic link instead.",
    };
  }
  if (storedEmail.toLowerCase() === data.user.email.toLowerCase()) {
    return undefined;
  }

  console.error(
    "GitHub sign-in rejected: the provider email does not match the account email",
    {
      userId: data.user.id,
      // メールアドレス自体は出力しない。
    },
  );
  return {
    error: "githubEmailMismatch",
    errorDescription:
      "This GitHub email address does not match the email on your account. Sign in with a magic link instead.",
  };
}

async function revokeUserSessionsQuietly(userId: string): Promise<void> {
  try {
    const revoked = await revokeAllUserSessions({ userId });
    console.error(
      "Revoked existing sessions while rejecting an unverified GitHub sign-in attempt",
      {
        userId,
        sessions: revoked.sessions,
        refreshTokenFamilies: revoked.refreshTokenFamilies,
      },
    );
  } catch (error) {
    // 失効に失敗してもサインイン自体は拒否済みなので先へ進める。
    console.error("Failed to revoke sessions for an unverified GitHub sign-in attempt", error);
  }
}
