import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function Page() {
  const session = await auth();
  const url = headers().get("x-url") || "/";
  if (!session?.user) {
    redirect(`/account/sign-in?returnUrl=${encodeURIComponent(url)}`);
  }

  redirect("/account/manage/profile");
}