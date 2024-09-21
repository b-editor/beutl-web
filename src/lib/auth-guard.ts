"use server";

import { auth } from "@/auth";
import type { Session } from "next-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function authOrSignIn() {
  const session = await auth();
  const url = headers().get("x-url") || "/";
  if (!session?.user) {
    const searchParams = new URLSearchParams();
    searchParams.set("returnUrl", url);
    redirect(`/account/sign-in?${searchParams.toString()}`);
  }

  if (session.user.id === undefined) {
    throw new Error("User ID is missing in session");
  }

  return session as Session & { user: NonNullable<Session["user"]> & { id: string } };
}