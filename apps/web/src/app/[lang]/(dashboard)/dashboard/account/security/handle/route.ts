import { getLanguage } from "@beutl/next/language";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";

export async function GET(): Promise<NextResponse> {
  const cookieStore = await cookies();
  const authFlow = cookieStore.get("beutl.auth-flow");
  const requestUrl = new URL((await headers()).get("x-url") as string);
  requestUrl.pathname = `/${await getLanguage()}/dashboard/account/security`;

  if (authFlow) {
    let flow: unknown = null;
    try {
      flow = JSON.parse(authFlow.value);
    } catch {
      // A malformed client cookie is discarded just like an invalid shape.
    }
    if (
      typeof flow !== "object" || flow === null ||
      !("type" in flow) || typeof flow.type !== "string" ||
      !("url" in flow) || typeof flow.url !== "string" || !flow.url ||
      flow.type === "adding-account"
    ) {
      cookieStore.delete("beutl.auth-flow");
    }
  }

  return NextResponse.redirect(requestUrl.toString());
}
