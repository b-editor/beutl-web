import { auth } from "@/auth";
import Form from "./form";
import type { SignInPageErrorParam } from "@auth/core/types";
import { cookies } from "next/headers";
import { localRedirect } from "@/lib/localRedirect";

export default async function Page({
  searchParams: { returnUrl, error },
  params: { lang },
}: {
  searchParams: {
    returnUrl?: string;
    error?: SignInPageErrorParam;
  };
  params: {
    lang: string;
  };
}) {
  const authFlow = cookies().get("beutl.auth-flow");
  if (authFlow?.value) {
    const json = JSON.parse(authFlow?.value);
    if (json.type === "adding-account" && json.url) {
      const url = new URL(json.url);
      if (error) {
        url.searchParams.set("error", error);
      }
      localRedirect(url.toString());
    }
  }

  const session = await auth();
  if (session) {
    localRedirect(returnUrl || `/${lang}`);
  }

  return <Form returnUrl={returnUrl} error={error} lang={lang} />;
}
