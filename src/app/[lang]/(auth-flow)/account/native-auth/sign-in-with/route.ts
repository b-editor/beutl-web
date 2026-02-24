import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/better-auth";
import { getLanguage } from "@/lib/lang-utils";
import { headers } from "next/headers";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const returnUrl = searchParams.get("returnUrl") || "";
  const provider = searchParams.get("provider") || "";
  const lang = await getLanguage();

  const session = await auth.api.getSession({ headers: await headers() });
  const continueUrl = new URL(`/${lang}/account/native-auth/continue`, request.nextUrl.origin);
  continueUrl.searchParams.set("returnUrl", returnUrl);

  if (!session?.user) {
    // TODO: デバッグ必要
    // Better Auth OAuth sign-in redirect
    const baseUrl = process.env.BETTER_AUTH_URL || request.nextUrl.origin;
    const signInUrl = new URL(`/api/auth/sign-in/${provider.toLowerCase()}`, baseUrl);
    signInUrl.searchParams.set("callbackURL", continueUrl.toString());
    return NextResponse.redirect(signInUrl.toString());
  } else {
    // アカウントが存在する
    return NextResponse.redirect(continueUrl.toString());
  }
}
