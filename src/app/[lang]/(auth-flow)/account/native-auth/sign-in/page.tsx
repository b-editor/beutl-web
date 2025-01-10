import { auth } from "@/auth";
import { redirect } from "next/navigation";

export default async function Page({
  searchParams: { returnUrl },
  params: { lang },
}: {
  searchParams: { returnUrl: string };
  params: { lang: string };
}) {
  const session = await auth();
  const continueUrl = `/${lang}/account/native-auth/continue?returnUrl=${encodeURIComponent(returnUrl)}`;

  if (!session?.user) {
    redirect(
      `/${lang}/account/sign-in?returnUrl=${encodeURIComponent(continueUrl)}`,
    );
  } else {
    // アカウントが存在する
    redirect(continueUrl);
  }
}
