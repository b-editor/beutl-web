import { type NextRequest, NextResponse } from "next/server";

export function GET(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider") as string;
  const returnUrl = req.nextUrl.searchParams.get("returnUrl") as string;
  const url = new URL("/account/native-auth/sign-in-with", req.nextUrl.origin);
  url.searchParams.set("provider", provider);
  url.searchParams.set("returnUrl", returnUrl);
  return NextResponse.redirect(url);
}
