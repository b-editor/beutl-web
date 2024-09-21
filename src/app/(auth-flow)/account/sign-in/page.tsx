import { auth } from "@/auth";
import { redirect } from "next/navigation";
import Form from "./form";
import type { SignInPageErrorParam } from "@auth/core/types";
import { cookies } from "next/headers";

export default async function Page({
  searchParams: {
    returnUrl,
    error
  }
}: {
  searchParams: {
    returnUrl?: string,
    error?: SignInPageErrorParam
  }
}) {
  const authFlow = cookies().get("beutl.auth-flow");
  if (authFlow?.value) {
    const json = JSON.parse(authFlow?.value);
    if (json.type === "adding-account" && json.url) {
      const url = new URL(json.url);
      if (error) {
        url.searchParams.set("error", error);
      }
      redirect(url.toString());
    }
  }

  const session = await auth();
  if (session) {
    redirect(returnUrl || "/");
  }

  return (
    <Form returnUrl={returnUrl} error={error} />
  )
}