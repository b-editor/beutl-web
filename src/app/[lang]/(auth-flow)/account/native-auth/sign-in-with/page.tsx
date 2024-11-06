import { auth, signIn } from "@/auth";
import { redirect } from "next/navigation";

export default async function Page({
  searchParams: { returnUrl, provider }
}: { searchParams: { returnUrl: string, provider: string } }
) {
  const session = await auth();
  const continueUrl = `/account/native-auth/continue?returnUrl=${encodeURIComponent(returnUrl)}`;

  if (!session?.user) {
    signIn(provider.toLowerCase(), { redirectTo: continueUrl.toString() });
  } else {
    // アカウントが存在する
    redirect(continueUrl.toString());
  }
}
