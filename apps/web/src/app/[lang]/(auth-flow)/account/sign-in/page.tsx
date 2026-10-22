import { auth } from "@/lib/better-auth";
import Form from "./form";
import { headers } from "next/headers";
import { localRedirect, resolveSafeReturnUrl } from "@beutl/next/local-redirect";
import { AuthLegalLinks } from "@/components/auth/legal-links";

export default async function Page(
  props: {
    searchParams: Promise<{
      returnUrl?: string;
      provider?: string;
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

  const returnUrl = await resolveSafeReturnUrl(searchParams.returnUrl);

  // デスクトップのソーシャルサインイン (sign-in-with ルート経由) は、この
  // ページで OAuth を自動開始させる。値は限定する。
  const provider =
    searchParams.provider === "google" || searchParams.provider === "github"
      ? searchParams.provider
      : undefined;

  const session = await auth.api.getSession({ headers: await headers(), query: { disableCookieCache: true } });
  if (session) {
    await localRedirect(returnUrl || `/${lang}/dashboard`);
  }

  return (
    <Form
      returnUrl={returnUrl}
      provider={provider}
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
