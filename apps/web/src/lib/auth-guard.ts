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
const getSession = cache(async () => {
  const headersList = await headers();
  return auth.api.getSession({ headers: headersList });
});

export async function authOrSignIn(): Promise<SafeSession> {
  const result = await getSession();
  if (!result?.user?.id) {
    const headersList = await headers();
    redirect(
      `/account/sign-in?returnUrl=${encodeURIComponent(headersList.get("x-url") || "/")}`,
    );
  }

  return result as SafeSession;
}

export async function authenticated<TResult>(
  fnc: (session: SafeSession) => Promise<TResult>,
) {
  // Authentication, the mutation and its audit/storage helpers otherwise each
  // create a Prisma client outside a React render. Keep the provider's after()
  // cleanup so pending storage work is not disconnected when the action returns.
  return await runWithSharedDb(async () => {
    const result = await getSession();
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

export async function throwIfUnauth() {
  const result = await getSession();
  if (!result?.user?.id) {
    throw new Error("Unauthenticated");
  }

  return result as SafeSession;
}
