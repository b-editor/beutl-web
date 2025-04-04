import { auth } from "@/auth";
import Form from "./form";
import type { SignInPageErrorParam } from "@auth/core/types";
import { cookies } from "next/headers";
import { localRedirect } from "@/lib/localRedirect";

export default async function Page(
  props: {
    searchParams: Promise<{
      returnUrl?: string;
      error?: SignInPageErrorParam;
    }>;
    params: Promise<{
      lang: string;
    }>;
  }
) {
  const params = await props.params;

  const {
    lang
  } = params;

  const searchParams = await props.searchParams;

  const {
    returnUrl,
    error
  } = searchParams;

  const authFlow = (await cookies()).get("beutl.auth-flow");
  if (authFlow?.value) {
    const json = JSON.parse(authFlow?.value);
    if (json.type === "adding-account" && json.url) {
      const url = new URL(json.url);
      if (error) {
        url.searchParams.set("error", error);
      }
      await localRedirect(url.toString());
    }
  }

  const session = await auth();
  if (session) {
    await localRedirect(returnUrl || `/${lang}`);
  }

  return <Form returnUrl={returnUrl} error={error} lang={lang} />;
}
