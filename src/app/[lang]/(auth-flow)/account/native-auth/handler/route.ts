import { auth } from "@/auth";
import { randomString } from "@/lib/create-hash";
import { prisma } from "@/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const identifier = request.nextUrl.searchParams.get("identifier") as string;
  const session = await auth();

  const xurl = request.headers.get("x-url") as string;
  if (!session?.user) {
    const continueUrl = `/account/native-auth/continue?returnUrl=${encodeURIComponent(xurl)}`;

    return NextResponse.redirect(new URL(`/account/sign-in?returnUrl=${encodeURIComponent(continueUrl)}`, xurl));
  } else {
    if (!session.user.id) {
      throw new Error("User id is not found");
    }

    const code = randomString(32);
    const obj = await prisma.nativeAppAuth.update({
      where: {
        id: identifier
      },
      data: {
        userId: session.user.id,
        codeExpires: new Date(Date.now() + 1000 * 60 * 30),
        code
      }
    });

    const continueUrl = new URL(obj.continueUrl, xurl);
    continueUrl.searchParams.set("code", code);
    // localhostかを判定
    if (continueUrl.hostname !== "localhost") {
      throw new Error("Invalid continue URL");
    }
    return NextResponse.redirect(continueUrl.toString());
  }
}