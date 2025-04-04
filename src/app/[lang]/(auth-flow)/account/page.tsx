import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const params = await props.params;

  const {
    lang
  } = params;

  const session = await auth();
  const url = (await headers()).get("x-url") || `/${lang}`;
  if (!session?.user) {
    redirect(`/${lang}/account/sign-in?returnUrl=${encodeURIComponent(url)}`);
  }

  redirect(`/${lang}/account/manage/profile`);
}
