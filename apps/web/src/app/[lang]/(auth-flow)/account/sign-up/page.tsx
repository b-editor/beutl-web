import { auth } from "@/lib/better-auth";
import Form from "./form";
import { localRedirect } from "@/lib/localRedirect";
import { headers } from "next/headers";

export default async function Page(
  props: {
    searchParams: Promise<{ returnUrl?: string; email?: string }>;
    params: Promise<{ lang: string }>;
  }
) {
  const params = await props.params;

  const {
    lang
  } = params;

  const searchParams = await props.searchParams;

  const {
    returnUrl,
    email
  } = searchParams;

  const session = await auth.api.getSession({ headers: await headers() });
  if (session) {
    await localRedirect(returnUrl || "/");
  }

  return <Form returnUrl={returnUrl} email={email} lang={lang} />;
}
