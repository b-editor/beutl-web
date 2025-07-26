import { auth } from "@/auth";
import { redirect } from "next/navigation";

export default async function Page(
  props: {
    searchParams: Promise<{ returnUrl: string }>;
    params: Promise<{ lang: string }>;
  }
) {
  const params = await props.params;

  const {
    lang
  } = params;

  const searchParams = await props.searchParams;

  const {
    returnUrl
  } = searchParams;

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
