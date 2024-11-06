import { auth, signOut } from "@/auth";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const session = await auth();
  const returnUrl = request.nextUrl.searchParams.get("returnUrl") || "";

  if (session?.user) {
    await signOut({ redirectTo: `/account/sign-in?returnUrl=${encodeURIComponent(returnUrl)}` });
  }

  return NextResponse.redirect(`/account/sign-in?returnUrl=${encodeURIComponent(returnUrl)}`);
}
