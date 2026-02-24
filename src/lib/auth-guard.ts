import "server-only";
import { auth } from "@/lib/better-auth";
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
  const result = await getSession();
  if (!result?.user?.id) {
    return { message: "Unauthenticated", success: false };
  }

  return await fnc(result as SafeSession);
}

export async function throwIfUnauth() {
  const result = await getSession();
  if (!result?.user?.id) {
    throw new Error("Unauthenticated");
  }

  return result as SafeSession;
}
