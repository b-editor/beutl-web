import { type NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const provider = encodeURIComponent(req.nextUrl.searchParams.get("provider") as string);
  const returnUrl = encodeURIComponent(req.nextUrl.searchParams.get("returnUrl") as string);

  return NextResponse.redirect(`/account/native-auth/sign-in-with?provider=${provider}&returnUrl=${returnUrl}`);
}
