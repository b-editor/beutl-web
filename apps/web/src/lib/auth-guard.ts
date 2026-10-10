import "server-only";
import type { ActionResult } from "@beutl/core";
import { runWithSharedDb } from "@beutl/db";
import { auth } from "@/lib/better-auth";
import type { BetterAuthSession, BetterAuthUser } from "@/lib/better-auth";
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

// React の cache は layout / page の描画中のセッション取得をまとめる。
// Server Action には効かないため、DB クライアントは authenticated のスコープで共有する。
const getSession = cache(async (authoritative = false) => {
  const headersList = await headers();
  return auth.api.getSession({
    headers: headersList,
    ...(authoritative ? { query: { disableCookieCache: true } } : {}),
  });
});

export async function authOrSignIn(authoritative = false): Promise<SafeSession> {
  const result = await getSession(authoritative);
  if (!result?.user?.id) {
    const headersList = await headers();
    redirect(`/account/sign-in?returnUrl=${encodeURIComponent(headersList.get("x-url") || "/")}`);
  }

  return result as SafeSession;
}

export async function authenticated<TResult>(
  fnc: (session: SafeSession) => Promise<TResult>,
  authoritative = false,
) {
  // Authentication, the mutation and its audit/storage helpers otherwise each
  // create a Prisma client outside a React render. Response cleanup still owns
  // this client; storage callbacks that run later acquire an independent client.
  return await runWithSharedDb(async () => {
    const result = await getSession(authoritative);
    if (!result?.user?.id) {
      const actionResult: ActionResult = {
        message: "Unauthenticated",
        success: false,
      };
      return actionResult;
    }

    return await fnc(result as SafeSession);
  });
}

/** Sensitive operations must consult the session store even with a valid cache cookie. */
export async function getAuthoritativeSession(): Promise<SafeSession | null> {
  return (await getSession(true)) as SafeSession | null;
}

export async function throwIfUnauth() {
  const result = await getSession();
  if (!result?.user?.id) {
    throw new Error("Unauthenticated");
  }

  return result as SafeSession;
}
