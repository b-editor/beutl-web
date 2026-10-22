"use server";

import { getAuthoritativeSession } from "@/lib/auth-guard";
import { issueNativeAuthCodeForSession } from "@beutl/next/native-auth-issuance";

export type NativeAuthIssueState =
  | { status: "idle" }
  | { status: "ok"; callbackUrl: string }
  | { status: "failed" };

export async function issueNativeAuthCodeAction(
  _state: NativeAuthIssueState,
  formData: FormData,
): Promise<NativeAuthIssueState> {
  const identifier = formData.get("identifier");
  const userId = formData.get("userId");
  if (typeof identifier !== "string" || !identifier || typeof userId !== "string" || !userId) {
    return { status: "failed" };
  }

  // Recheck the session store and the account shown on the consent page.
  const session = await getAuthoritativeSession();
  if (!session?.user?.id || session.user.id !== userId) return { status: "failed" };

  try {
    const result = await issueNativeAuthCodeForSession({ identifier, userId: session.user.id });
    return result.ok
      ? { status: "ok", callbackUrl: result.callbackUrl }
      : { status: "failed" };
  } catch (error) {
    console.error("Failed to issue native sign-in code", error);
    return { status: "failed" };
  }
}
