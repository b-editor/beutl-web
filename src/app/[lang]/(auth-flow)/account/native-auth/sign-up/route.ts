import { auth, signOut } from "@/auth";
import { getLanguage } from "@/lib/lang-utils";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const session = await auth();
  const returnUrl = request.nextUrl.searchParams.get("returnUrl") || "";
  const lang = await getLanguage();

  const continueUrl = new URL(`/${lang}/account/sign-in`, request.nextUrl.origin);
  continueUrl.searchParams.set("returnUrl", returnUrl);

  if (session?.user) {
    await signOut({
      redirectTo: continueUrl.toString(),
    });
  }

  return NextResponse.redirect(continueUrl.toString());
}
