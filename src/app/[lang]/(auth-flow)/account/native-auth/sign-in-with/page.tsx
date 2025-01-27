import { auth, signIn } from "@/auth";
import { redirect } from "next/navigation";

export default async function Page({
  searchParams: { returnUrl, provider },
  params: { lang },
}: {
  searchParams: { returnUrl: string; provider: string };
  params: { lang: string };
}) {
  const session = await auth();
  const continueUrl = `/${lang}/account/native-auth/continue?returnUrl=${encodeURIComponent(returnUrl)}`;

  if (!session?.user) {
    await signIn(provider.toLowerCase(), { redirectTo: continueUrl.toString() });
  } else {
    // アカウントが存在する
    redirect(continueUrl.toString());
  }
}
