"use server";

import { signOut } from "@/auth";
import { getLanguage } from "@/lib/lang-utils";

export async function signOutAction(): Promise<undefined> {
  await signOut({ redirectTo: `/${await getLanguage()}` });
}
