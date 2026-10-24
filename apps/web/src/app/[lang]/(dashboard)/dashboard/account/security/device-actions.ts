"use server";

import { revokeNativeDevice } from "@beutl/db";
import { getAuthoritativeSession } from "@/lib/auth-guard";

export async function disconnectDevice(id: string) {
  const session = await getAuthoritativeSession();
  if (!session || typeof id !== "string" || id.length > 100) return { success: false };
  try {
    return { success: await revokeNativeDevice(session.user.id, id) };
  } catch {
    return { success: false };
  }
}
