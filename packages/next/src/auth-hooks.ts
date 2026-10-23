import "server-only";
import type { ValidateUserInfoResult, ValidateUserInfoSource } from "better-auth";
import { getDb, isUniqueConstraintViolation, profileUserNameFilter } from "@beutl/db";
import { addAuditLog, auditLogActions } from "./audit-log";

export function validateOAuthUserInfo({ user, source }: {
  user: { emailVerified?: boolean };
  source: ValidateUserInfoSource;
}): ValidateUserInfoResult | undefined {
  if (source.method !== "oauth" || source.oauth?.providerId !== "github") return;
  // Returning sign-ins already resolve by providerId + accountId. A changed
  // provider email must not invalidate that binding or revoke existing sessions.
  if (source.action === "sign-in" || user.emailVerified === true) return;

  return {
    error: "githubEmailNotVerified",
    errorDescription:
      "A verified GitHub email is required to create or link an account. Check your GitHub email settings and try again.",
  };
}

// better-auth の user.create.after は、どの Worker がユーザーを作ったかに関わらず
// 走る必要がある。Profile はアプリ全体が存在を前提にしており (公開プロフィール、
// パッケージの発行者表示など)、片方の Worker にだけフックがあると
// Profile を持たないユーザーが生まれる。
//
// 管理 Worker はサインアップ導線を塞いでいるが、better-auth には
// requestSignUp / idToken など設定だけでは塞ぎ切れない経路があるため、
// フック自体を両アプリで共有して取りこぼしを無くす。
export async function onUserCreated(user: {
  id: string;
  email?: string | null;
  name?: string | null;
}): Promise<void> {
  const db = await getDb();
  let userName = user.email?.split("@")[0];
  if (!userName) return;

  const original = userName;
  for (let i = 0; ; i++) {
    userName = i === 0 ? original : `${original}${i}`;
    const exists = await db.profile.findFirst({
      where: { userName: profileUserNameFilter(userName) },
    });
    if (exists) continue;
    try {
      await db.profile.create({
        data: {
          userId: user.id,
          displayName: user.name || userName,
          userName,
        },
      });
      break;
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      // A duplicate hook invocation must not loop forever on the userId key.
      if (await db.profile.findUnique({ where: { userId: user.id } })) return;
      // A concurrent signup claimed this name. Try the next suffix.
    }
  }

  await addAuditLog({
    userId: user.id,
    action: auditLogActions.authjs.createUser,
    details: `userName: ${userName}, email: ${user.email}`,
  });
}
