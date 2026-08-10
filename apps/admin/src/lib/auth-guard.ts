import "server-only";
import type { ActionResult } from "@beutl/core";
import { auth } from "@/lib/better-auth";
import { isAdmin } from "@beutl/core";
import type { BetterAuthSession, BetterAuthUser } from "@/lib/better-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export interface SafeUser extends BetterAuthUser {
  id: string;
}

export interface SafeSession {
  session: BetterAuthSession;
  user: SafeUser;
}

async function getSession() {
  const headersList = await headers();
  return auth.api.getSession({ headers: headersList });
}

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
    const headersList = await headers();
    redirect(
      `/account/sign-in?returnUrl=${encodeURIComponent(headersList.get("x-url") || "/")}`,
    );
  }

  if (!isAdmin(result.user.id)) {
    redirect("/forbidden");
  }

  return result as SafeSession;
}
