import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function Page({params: { lang }}: { params: { lang: string } }) {
  const session = await auth();
  const url = headers().get("x-url") || `/${lang}`;
  if (!session?.user) {
    redirect(`/${lang}/account/sign-in?returnUrl=${encodeURIComponent(url)}`);
  }

  redirect(`/${lang}/account/manage/profile`);
}