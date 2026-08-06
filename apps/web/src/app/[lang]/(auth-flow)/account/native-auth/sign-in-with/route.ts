import { type NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/better-auth";
import { getLanguage } from "@/lib/lang-utils";
import { headers } from "next/headers";

export async function GET(request: NextRequest) {
  const auth = await getAuth();
  const searchParams = request.nextUrl.searchParams;
  const returnUrl = searchParams.get("returnUrl") || "";
  const provider = searchParams.get("provider") || "";
  const lang = await getLanguage();

  const session = await auth.api.getSession({ headers: await headers() });
  const continueUrl = new URL(`/${lang}/account/native-auth/continue`, request.nextUrl.origin);
  continueUrl.searchParams.set("returnUrl", returnUrl);

  if (!session?.user) {
    const response = await auth.api.signInSocial({
      body: {
        provider: provider.toLowerCase(),
        callbackURL: continueUrl.toString(),
      }
    });
    if (response.url) {
      return NextResponse.redirect(response.url);
    } else {
      return NextResponse.redirect(`/${lang}/account/sign-in?returnUrl=${encodeURIComponent(continueUrl.toString())}`);
    }
  } else {
    // アカウントが存在する
    return NextResponse.redirect(continueUrl.toString());
  }
}
