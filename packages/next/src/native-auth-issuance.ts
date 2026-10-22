import "server-only";
import { isAllowedNativeAuthContinueUrl, nativeAuthCallbackUrl, randomString } from "@beutl/core";
import { findNativeAppAuthById, updateNativeAppAuthCode } from "@beutl/db";

type NativeAuthIssueResult =
  | { ok: true; callbackUrl: string }
  | { ok: false; reason: "rowNotFound" | "unsafeContinueUrl" };

/** Called only after the consent action checks the current session. */
export async function issueNativeAuthCodeForSession({ identifier, userId }: {
  identifier: string;
  userId: string;
}): Promise<NativeAuthIssueResult> {
  const row = await findNativeAppAuthById({ id: identifier });
  if (!row) return { ok: false, reason: "rowNotFound" };

  const code = randomString(32);
  let callbackUrl: string;
  try {
    // Validate persisted destinations before writing any code or user binding.
    callbackUrl = nativeAuthCallbackUrl(row.continueUrl, code);
  } catch {
    // Invalid stored URLs are validation failures; refuse without issuing credentials.
    return { ok: false, reason: "unsafeContinueUrl" };
  }

  await updateNativeAppAuthCode({
    id: row.id,
    userId,
    code,
    codeExpires: new Date(Date.now() + 30 * 60 * 1000),
  });
  return { ok: true, callbackUrl };
}

export function nativeAuthDestinationHost(continueUrl: string): string | null {
  try {
    const url = new URL(continueUrl);
    return isAllowedNativeAuthContinueUrl(url) ? url.host : null;
  } catch {
    // A malformed stored URL has no safe destination to display for consent.
    return null;
  }
}
