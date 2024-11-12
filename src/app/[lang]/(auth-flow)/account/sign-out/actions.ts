"use server";

import { signOut } from "@/auth";
import { getLanguage } from "@/lib/lang-utils";

export async function signOutAction(_: undefined, __: FormData): Promise<undefined> {
  await signOut({ redirectTo: `/${getLanguage()}` });
}
