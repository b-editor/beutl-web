import "server-only";
import type { ActionResult } from "@beutl/core";
import { auth } from "@/lib/better-auth";
import { isAdmin } from "@beutl/core";
import type { BetterAuthSession, BetterAuthUser } from "@/lib/better-auth";
import { getLanguage } from "@beutl/next/language";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

interface SafeUser extends BetterAuthUser {
  id: string;
}

interface SafeSession {
  session: BetterAuthSession;
  user: SafeUser;
}

// layout と page の両方が requireAdmin を呼ぶため、1 リクエスト内で
// セッション取得が重複する。React の cache でリクエスト単位に 1 回へまとめる。
const getSession = cache(async () => {
  const headersList = await headers();
  return auth.api.getSession({ headers: headersList });
});

// 管理画面の Server Action はこちらを使うこと。管理者判定を呼び出し側の任意にしない。
// BETTER_AUTH_COOKIE_DOMAIN によりセッションは公開サイトと共有されるため、
// 認証だけを見る関数を外に出すのは管理者判定込みの adminAction / requireAdmin だけ。
// Generic in what the action returns so a read-only lookup can hand back the
// data it found; the union keeps the refusals, which carry no payload.
export async function adminAction<T extends ActionResult>(
  fnc: (session: SafeSession) => Promise<T>,
): Promise<T | ActionResult> {
  const result = await getSession();
  if (!result?.user?.id) {
    return { message: "Unauthenticated", success: false };
  }
  if (!isAdmin(result.user.id)) {
    return { success: false, message: "Forbidden" };
  }

  return await fnc(result as SafeSession);
}

export async function requireAdmin(): Promise<SafeSession> {
  const result = await getSession();
  if (!result?.user?.id || !isAdmin(result.user.id)) {
    const [headersList, lang] = await Promise.all([headers(), getLanguage()]);
    if (!result?.user?.id) {
      redirect(
        `/${lang}/account/sign-in?returnUrl=${encodeURIComponent(headersList.get("x-url") || "/")}`,
      );
    }
    redirect(`/${lang}/forbidden`);
  }

  return result as SafeSession;
}
