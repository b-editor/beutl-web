import { OAuthConsentPage } from "./oauth-page";
import { getTranslation } from "@beutl/i18n";
import { auth } from "@/lib/better-auth";
import { findNativeAppAuthById } from "@beutl/db";
import { nativeAuthDestinationHost } from "@beutl/next/native-auth-issuance";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Avatar, AvatarFallback, AvatarImage } from "@beutl/ui/ui/avatar";
import { Card, CardContent, CardDescription, CardHeader, CardFooter, CardTitle } from "@beutl/ui/ui/card";
import { AuthLogo } from "@/components/auth/auth-logo";
import { AuthLegalLinks } from "@/components/auth/legal-links";
import { NativeAuthConsentForm } from "./components";

export default async function Page(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const search = await props.searchParams;
  if (typeof search.sig === "string") {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) {
      for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
    }
    return <OAuthConsentPage oauthQuery={query.toString()} lang={lang} />;
  }
  const { identifier } = search;
  const { t } = await getTranslation(lang);
  const row = typeof identifier === "string" && identifier
    ? await findNativeAppAuthById({ id: identifier })
    : null;
  const host = row && nativeAuthDestinationHost(row.continueUrl);
  if (!row || !host) {
    return <ExpiredCard lang={lang} message={t("auth:nativeAuth.linkExpired")} />;
  }

  const returnUrl = `/${lang}/account/native-auth/handler?identifier=${encodeURIComponent(row.id)}`;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    redirect(`/${lang}/account/sign-in?returnUrl=${encodeURIComponent(returnUrl)}`);
  }
  const user = session.user;

  return (
    <div className="h-screen flex items-center justify-center">
      <div className="w-[350px] flex flex-col gap-4 relative">
        <AuthLogo />
        <Card>
          <CardHeader>
            <CardTitle>{t("auth:confirmation")}</CardTitle>
            <CardDescription>{t("auth:doYouWantToContinue")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="w-full flex gap-4">
              <Avatar className="w-12 h-12">
                <AvatarFallback>{user.email?.charAt(0)?.toUpperCase()}</AvatarFallback>
                {user.image && <AvatarImage src={user.image} alt="Profile image" />}
              </Avatar>
              <div className="flex flex-col">
                <p className="font-bold">{user.name}</p>
                <p className="text-muted-foreground">{user.email}</p>
              </div>
            </div>
            <div className="mt-4">
              <p className="text-sm text-muted-foreground">{t("auth:nativeAuth.codeDestination")}</p>
              <p className="text-sm font-mono">{host}</p>
            </div>
          </CardContent>
          <CardFooter className="block">
            <NativeAuthConsentForm
              identifier={row.id}
              userId={user.id}
              submitLabel={t("continue")}
              failureText={t("auth:nativeAuth.issueFailed")}
            />
            <Link
              href={`/${lang}/account/native-auth/sign-up?returnUrl=${encodeURIComponent(returnUrl)}`}
              prefetch={false}
              className="text-sm font-medium inline-block mt-6"
            >
              {t("auth:useAnotherAccount")}
            </Link>
          </CardFooter>
        </Card>
        <AuthLegalLinks lang={lang} className="absolute top-full right-0 translate-y-4" />
      </div>
    </div>
  );
}

function ExpiredCard({ lang, message }: { lang: string; message: string }) {
  return (
    <div className="h-screen flex items-center justify-center">
      <div className="w-[350px] flex flex-col gap-4 relative">
        <AuthLogo />
        <Card>
          <CardHeader><CardDescription>{message}</CardDescription></CardHeader>
        </Card>
        <AuthLegalLinks lang={lang} className="absolute top-full right-0 translate-y-4" />
      </div>
    </div>
  );
}
