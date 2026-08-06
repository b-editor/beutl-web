import { getAuth } from "@/lib/better-auth";
import { getLanguage } from "@/lib/lang-utils";
import { type NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";

export async function GET(request: NextRequest) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  const returnUrl = request.nextUrl.searchParams.get("returnUrl") || "";
  const lang = await getLanguage();

  const continueUrl = new URL(`/${lang}/account/sign-in`, request.nextUrl.origin);
  continueUrl.searchParams.set("returnUrl", returnUrl);

  if (session?.user) {
    await auth.api.signOut({
      headers: await headers(),
    });

    // Clear cookies and redirect
    return NextResponse.redirect(continueUrl.toString());
  }

  return NextResponse.redirect(continueUrl.toString());
}
