import { auth, signIn } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function Page({
  searchParams: { returnUrl, provider }
}: { searchParams: { returnUrl: string, provider: string } }
) {
  const session = await auth();
  const url = headers().get("x-url") as string;
  const origin = new URL(url).origin;
  const continueUrl = new URL("/account/native-auth/continue", origin);
  continueUrl.searchParams.set("returnUrl", returnUrl);

  if (!session?.user) {
    signIn(provider.toLowerCase(), { redirectTo: continueUrl.toString() });
  } else {
    // アカウントが存在する
    redirect(continueUrl.toString());
  }
}
