import { auth } from "@/auth";
import { redirect } from "next/navigation";

export default async function Page({ searchParams: { returnUrl } }: { searchParams: { returnUrl: string } }) {
  const session = await auth();
  const continueUrl = `/account/native-auth/continue?returnUrl=${encodeURIComponent(returnUrl)}`;

  if (!session?.user) {
    redirect(`/account/sign-in?returnUrl=${encodeURIComponent(continueUrl)}`);
  } else {
    // アカウントが存在する
    redirect(continueUrl);
  }
}
