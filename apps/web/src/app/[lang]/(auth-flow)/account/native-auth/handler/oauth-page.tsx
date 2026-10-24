import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@beutl/db";
import { NATIVE_CLIENT_NAME } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";
import { Avatar, AvatarFallback, AvatarImage } from "@beutl/ui/ui/avatar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardFooter,
  CardTitle,
} from "@beutl/ui/ui/card";
import { AuthLogo } from "@/components/auth/auth-logo";
import { AuthLegalLinks } from "@/components/auth/legal-links";
import { getAuth } from "@/lib/better-auth";
import { readNativeOAuthQuery } from "@/lib/native-oauth";
import { OAuthConsentForm } from "./oauth-form";

export async function OAuthConsentPage({ oauthQuery, lang }: { oauthQuery: string; lang: string }) {
  const instance = await getAuth();
  const request = await readNativeOAuthQuery(oauthQuery, (await instance.$context).secret);
  const { t } = await getTranslation(lang);
  const session =
    request &&
    (await instance.api.getSession({
      headers: await headers(),
      query: { disableCookieCache: true },
    }));
  if (request && !session)
    redirect(
      `/${lang}/account/sign-in?returnUrl=${encodeURIComponent(`/api/auth/oauth2/authorize?${oauthQuery}`)}`,
    );
  const hasPasskeys = session
    ? (await (await getDb()).passkey.count({ where: { userId: session.user.id } })) > 0
    : false;
  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-24">
      <div className="relative flex w-full max-w-[350px] flex-col gap-4">
        <AuthLogo />
        <Card>
          {!request || !session ? (
            <CardHeader>
              <CardDescription role="alert">{t("auth:nativeAuth.linkExpired")}</CardDescription>
            </CardHeader>
          ) : (
            <>
              <CardHeader>
                <CardTitle>{t("auth:deviceAuthorization.title")}</CardTitle>
                <CardDescription>{t("auth:deviceAuthorization.description")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-4">
                  <Avatar className="size-12 shrink-0">
                    <AvatarFallback>{session.user.email.charAt(0).toUpperCase()}</AvatarFallback>
                    {session.user.image && <AvatarImage src={session.user.image} alt="" />}
                  </Avatar>
                  <div className="min-w-0">
                    <p className="font-bold wrap-anywhere">{session.user.name}</p>
                    <p className="text-sm text-muted-foreground wrap-anywhere">
                      {session.user.email}
                    </p>
                  </div>
                </div>
                <dl className="space-y-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">
                      {t("auth:deviceAuthorization.application")}
                    </dt>
                    <dd>{NATIVE_CLIENT_NAME}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {t("auth:deviceAuthorization.device")}
                    </dt>
                    <dd className="wrap-anywhere">{request.name}</dd>
                  </div>
                </dl>
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">
                    {t("auth:deviceAuthorization.permissions")}
                  </summary>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
                    {["profile", "content", "projects", "ai"].map((key) => (
                      <li key={key}>{t(`auth:deviceAuthorization.${key}`)}</li>
                    ))}
                  </ul>
                </details>
              </CardContent>
              <CardFooter className="block space-y-4">
                <p className="text-sm text-muted-foreground">
                  {t("auth:deviceAuthorization.initiatedByYou")}
                </p>
                <OAuthConsentForm
                  lang={lang}
                  oauthQuery={oauthQuery}
                  userId={session.user.id}
                  hasPasskeys={hasPasskeys}
                />
              </CardFooter>
            </>
          )}
        </Card>
        <AuthLegalLinks lang={lang} className="absolute top-full right-0 translate-y-4" />
      </div>
    </main>
  );
}
