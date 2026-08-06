"use server";

import { getAuth } from "@/lib/better-auth";
import { getLanguage } from "@/lib/lang-utils";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function signOutAction(): Promise<undefined> {
  const lang = await getLanguage();
  const auth = await getAuth();
  const headersList = await headers();

  // Better Auth でサインアウト
  await auth.api.signOut({
    headers: headersList,
  });

  redirect(`/${lang}`);
}
