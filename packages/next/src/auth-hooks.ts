import "server-only";
import { getDb } from "@beutl/db";
import { addAuditLog, auditLogActions } from "./audit-log";

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
  let exists = await db.profile.findFirst({
    where: { userName: original },
  });
  for (let i = 1; exists; i++) {
    userName = `${original}${i}`;
    exists = await db.profile.findFirst({
      where: { userName },
    });
  }

  await db.profile.create({
    data: {
      userId: user.id,
      displayName: user.name || userName,
      userName,
    },
  });

  await addAuditLog({
    userId: user.id,
    action: auditLogActions.authjs.createUser,
    details: `userName: ${userName}, email: ${user.email}`,
  });
}
