import { type NextRequest, NextResponse } from "next/server";
import { auth, signIn } from "@/auth";
import { getLanguage } from "@/lib/lang-utils";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const returnUrl = searchParams.get("returnUrl") || "";
  const provider = searchParams.get("provider") || "";
  const lang = await getLanguage();

  const session = await auth();
  const continueUrl = new URL(`/${lang}/account/native-auth/continue`, request.nextUrl.origin);
  continueUrl.searchParams.set("returnUrl", returnUrl);

  if (!session?.user) {
    await signIn(provider.toLowerCase(), { redirectTo: continueUrl.toString() });
  } else {
    // アカウントが存在する
    return NextResponse.redirect(continueUrl.toString());
  }
}
