import { type NextRequest, NextResponse } from "next/server";
import { auth, signIn } from "@/auth";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const returnUrl = searchParams.get("returnUrl") || "";
  const provider = searchParams.get("provider") || "";
  const lang = request.nextUrl.pathname.split('/')[1];

  const session = await auth();
  const continueUrl = `/${lang}/account/native-auth/continue?returnUrl=${encodeURIComponent(returnUrl)}`;

  if (!session?.user) {
    await signIn(provider.toLowerCase(), { redirectTo: continueUrl.toString() });
  } else {
    // アカウントが存在する
    return NextResponse.redirect(continueUrl.toString());
  }
}
