import { auth } from "@/lib/better-auth";
import Form from "./form";
import { localRedirect, resolveSafeReturnUrl } from "@beutl/next/local-redirect";
import { headers } from "next/headers";
import { AuthLegalLinks } from "@/components/auth/legal-links";

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

  const { email } = searchParams;
  const returnUrl = await resolveSafeReturnUrl(searchParams.returnUrl);

  const session = await auth.api.getSession({ headers: await headers() });
  if (session) {
    await localRedirect(returnUrl || "/");
  }

  return (
    <Form
      returnUrl={returnUrl}
      email={email}
      lang={lang}
      legalLinks={
        <AuthLegalLinks
          lang={lang}
          agreement
          className="absolute top-full right-0 translate-y-4"
        />
      }
    />
  );
}
