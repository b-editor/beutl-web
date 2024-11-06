"use server";

import { signOut } from "@/auth";

export async function signOutAction(_: undefined, __: FormData): Promise<undefined> {
  await signOut({ redirectTo: "/" });
}
