"use server";

import { auth } from "@/auth";

export async function handleGet(name: string) {
  const session = await auth();
  await new Promise(resolve => setTimeout(resolve, 1000));
}