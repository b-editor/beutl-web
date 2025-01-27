import "server-only";
import { auth } from "@/auth";
import type { Session, User } from "next-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export interface SafeUser extends User {
  id: string;
}

export interface SafeSession extends Session {
  user: SafeUser;
}

export async function authOrSignIn(): Promise<SafeSession> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(
      `/account/sign-in?returnUrl=${encodeURIComponent(headers().get("x-url") || "/")}`,
    );
  }

  return session as SafeSession;
}

export async function authenticated<TResult>(
  fnc: (session: SafeSession) => Promise<TResult>,
) {
  const session = await auth();
  if (!session?.user?.id) {
    return { message: "Unauthenticated", success: false };
  }

  return await fnc(session as SafeSession);
}

export async function throwIfUnauth() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthenticated");
  }

  return session as SafeSession;
}
