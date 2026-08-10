import "server-only";
import type { ActionResult } from "@beutl/core";
import { auth } from "@/lib/better-auth";
import { isAdmin } from "@beutl/core";
import type { BetterAuthSession, BetterAuthUser } from "@/lib/better-auth";
import { getLanguage } from "@beutl/next/language";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

export interface SafeUser extends BetterAuthUser {
  id: string;
}

export interface SafeSession {
  session: BetterAuthSession;
  user: SafeUser;
}

// layout と page の両方が requireAdmin を呼ぶため、1 リクエスト内で
// セッション取得が重複する。React の cache でリクエスト単位に 1 回へまとめる。
const getSession = cache(async () => {
  const headersList = await headers();
  return auth.api.getSession({ headers: headersList });
});

export async function authenticated<TResult>(
  fnc: (session: SafeSession) => Promise<TResult>,
) {
  const result = await getSession();
  if (!result?.user?.id) {
    const actionResult: ActionResult = {
      message: "Unauthenticated",
      success: false,
    };
    return actionResult;
  }

  return await fnc(result as SafeSession);
}

export async function requireAdmin(): Promise<SafeSession> {
  const result = await getSession();
  if (!result?.user?.id) {
    const [headersList, lang] = await Promise.all([headers(), getLanguage()]);
    redirect(
      `/${lang}/account/sign-in?returnUrl=${encodeURIComponent(headersList.get("x-url") || "/")}`,
    );
  }

  if (!isAdmin(result.user.id)) {
    redirect(`/${await getLanguage()}/forbidden`);
  }

  return result as SafeSession;
}
