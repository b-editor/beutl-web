import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function Page() {
  const session = await auth();
  const url = headers().get("x-url") || "/";
  if (!session?.user) {
    const searchParams = new URLSearchParams();
    searchParams.set("returnUrl", url);
    redirect(`/account/sign-in?${searchParams.toString()}`);
  }

  redirect("/account/manage/profile");
}