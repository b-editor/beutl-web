"use server";

import { getAuth } from "@/lib/better-auth";
import { getLanguage } from "@beutl/next/language";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function signOutAction(): Promise<undefined> {
  const lang = await getLanguage();
  const auth = await getAuth();
  const headersList = await headers();

  await auth.api.signOut({
    headers: headersList,
  });

  redirect(`/${lang}/account/sign-in`);
}
