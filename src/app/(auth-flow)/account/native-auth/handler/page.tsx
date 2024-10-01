import { auth } from "@/auth";
import { randomString } from "@/lib/create-hash";
import { prisma } from "@/prisma";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function Page({ searchParams: { identifier } }: { searchParams: { identifier: string } }) {
  const session = await auth();

  if (!session?.user) {
    const xurl = headers().get("x-url") as string;
    const origin = new URL(xurl).origin;
    const continueUrl = new URL("/account/native-auth/continue", origin);
    continueUrl.searchParams.set("returnUrl", xurl);

    const url = new URL("/account/sign-in");
    url.searchParams.set("returnUrl", continueUrl.toString());

    redirect(url.toString());
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

    const continueUrl = new URL(obj.continueUrl);
    continueUrl.searchParams.set("code", code);
    redirect(continueUrl.toString());
  }
}