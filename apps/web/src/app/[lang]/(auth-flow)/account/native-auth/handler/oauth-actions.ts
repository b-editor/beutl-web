"use server";

import { nativeOAuthIssuer } from "@beutl/core";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/better-auth";
import { readNativeOAuthQuery } from "@/lib/native-oauth";

export async function consentToNativeOAuth(
  oauthQuery: string,
  expectedUserId: string,
  accept: boolean,
) {
  let callbackUrl: string;
  try {
    const instance = await getAuth();
    if (!(await readNativeOAuthQuery(oauthQuery, (await instance.$context).secret)))
      return { success: false as const };
    const requestHeaders = await headers();
    const session = await instance.api.getSession({
      headers: requestHeaders,
      query: { disableCookieCache: true },
    });
    if (!session || session.user.id !== expectedUserId) return { success: false as const };
    const result = await instance.api.oauth2Consent({
      asResponse: false,
      request: new Request(`${nativeOAuthIssuer()}/oauth2/consent`, {
        method: "POST",
        headers: requestHeaders,
      }),
      headers: requestHeaders,
      body: { accept, oauth_query: oauthQuery },
    });
    callbackUrl = result.url;
  } catch {
    return { success: false as const };
  }
  // Let Next.js finish the action before navigating away from its response stream.
  redirect(callbackUrl);
}
