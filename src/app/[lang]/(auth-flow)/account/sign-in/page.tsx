import { auth } from "@/lib/better-auth";
import Form from "./form";
import { headers } from "next/headers";
import { localRedirect } from "@/lib/localRedirect";

export default async function Page(
  props: {
    searchParams: Promise<{
      returnUrl?: string;
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
    returnUrl
  } = searchParams;

  const session = await auth.api.getSession({ headers: await headers() });
  if (session) {
    await localRedirect(returnUrl || `/${lang}`);
  }

  return <Form returnUrl={returnUrl} lang={lang} />;
}
