import { auth, signOut } from "@/auth";
import { getLanguage } from "@/lib/lang-utils";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const session = await auth();
  const returnUrl = request.nextUrl.searchParams.get("returnUrl") || "";
  const lang = getLanguage();

  if (session?.user) {
    await signOut({
      redirectTo: `/${lang}/account/sign-in?returnUrl=${encodeURIComponent(returnUrl)}`,
    });
  }

  return NextResponse.redirect(
    `/${lang}/account/sign-in?returnUrl=${encodeURIComponent(returnUrl)}`,
  );
}
