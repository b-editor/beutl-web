import { getTranslation } from "@beutl/i18n";
import { auth } from "@/lib/better-auth";
import { findNativeAppAuthById } from "@beutl/db";
import { nativeAuthDestinationHost } from "@beutl/next/native-auth-issuance";
import { headers } from "next/headers";
import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { Avatar, AvatarFallback, AvatarImage } from "@beutl/ui/ui/avatar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardFooter,
  CardTitle,
} from "@beutl/ui/ui/card";
import { AuthLegalLinks } from "@/components/auth/legal-links";
import { NativeAuthConsentForm } from "./components";

// デスクトップアプリのコールバック受け元。createAuthUri は
// /account/native-auth/handler?identifier=... を返すため、ここに来る
// URL はこの形のみを想定する (余計な query は破棄する)。x-url ではなく
// 自分で URL を組み立て、header 差し込みの影響を受けないようにする。
function selfUrl(lang: string, identifier: string): string {
  return `/${lang}/account/native-auth/handler?identifier=${encodeURIComponent(identifier)}`;
}

export default async function Page(
  props: {
    searchParams: Promise<{ identifier: string }>;
    params: Promise<{ lang: string }>;
  }
) {
  const params = await props.params;

  const {
    lang
  } = params;

  const searchParams = await props.searchParams;

  const {
    identifier
  } = searchParams;

  const headersList = await headers();
  const session = await auth.api.getSession({ headers: headersList });
  if (!session?.user) {
    // サインインしていない訪問はコード発行へ進めない。以前と同じく同意
    // 画面 (continue) を挟んでサインインへ引き渡す。continue が遷移先の
    // 検証を一手に引き受けるため、このページはリクエストの URL を信用
    // しない。
    const continueUrl = `/${lang}/account/native-auth/continue?returnUrl=${encodeURIComponent(selfUrl(lang, identifier ?? ""))}`;

    redirect(
      `/${lang}/account/sign-in?returnUrl=${encodeURIComponent(continueUrl)}`,
    )
  }

  const user = session.user;
  const { t } = await getTranslation(lang);

  // GET の描画では何も発行しない (drive-by code issuance の核となって
  // いた動作)。発行は consent カードの Server Action でのみ行う。
  if (!identifier) {
    return <ExpiredCard lang={lang} message={t("auth:nativeAuth.linkExpired")} />;
  }
  const row = await findNativeAppAuthById({ id: identifier });
  if (!row) {
    return <ExpiredCard lang={lang} message={t("auth:nativeAuth.linkExpired")} />;
  }

  // 同意画面に載せる宛先。検証を通らない URL は表示にも発行にも出さない
  // (発行側で再度検証するが、画面と発行先が一致していることが同意の条件)。
  const host = nativeAuthDestinationHost(row.continueUrl);
  if (!host) {
    return <ExpiredCard lang={lang} message={t("auth:nativeAuth.linkExpired")} />;
  }

  // アカウント切替は continue 画面のサインアウトチェーンと同じ形へ。
  // 切替後も順路は continue → この handler (consent) となる。
  const routeBackUrl = `/${lang}/account/native-auth/continue?returnUrl=${encodeURIComponent(selfUrl(lang, identifier))}`;

  return (
    <div className="h-screen flex items-center justify-center">
      <div className="w-[350px] flex flex-col gap-4 relative">
        <div className="flex gap-2 absolute bottom-full left-1/2 -translate-x-1/2 -translate-y-4">
          <Image
            width={40}
            height={40}
            className="w-10 h-10 align-bottom"
            src="/img/logo_dark.svg"
            alt="Logo"
          />
          <h1 className="font-semibold text-3xl mt-1">Beutl</h1>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t("auth:confirmation")}</CardTitle>
            <CardDescription>{t("auth:doYouWantToContinue")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="w-full flex gap-4">
              <Avatar className="w-12 h-12">
                <AvatarFallback>
                  {user.email?.charAt(0)?.toUpperCase()}
                </AvatarFallback>
                {user.image && (
                  <AvatarImage src={user.image} alt="Profile image" />
                )}
              </Avatar>
              <div className="flex flex-col">
                <p className="font-bold">{user.name}</p>
                <p className="text-muted-foreground">{user.email}</p>
              </div>
            </div>
            <div className="mt-4">
              <p className="text-sm text-muted-foreground">
                {t("auth:nativeAuth.codeDestination")}
              </p>
              <p className="text-sm font-mono">{host}</p>
            </div>
          </CardContent>
          <CardFooter className="block">
            <NativeAuthConsentForm
              identifier={identifier}
              submitLabel={t("continue")}
              failureText={t("auth:nativeAuth.issueFailed")}
            />
            <Link
              href={`/${lang}/account/native-auth/sign-up?returnUrl=${encodeURIComponent(routeBackUrl)}`}
              prefetch={false}
              className="text-sm font-medium inline-block mt-6"
            >
              {t("auth:useAnotherAccount")}
            </Link>
          </CardFooter>
        </Card>
        <AuthLegalLinks
          lang={lang}
          className="absolute top-full right-0 translate-y-4"
        />
      </div>
    </div>
  );
}

function ExpiredCard({ lang, message }: { lang: string; message: string }) {
  return (
    <div className="h-screen flex items-center justify-center">
      <div className="w-[350px] flex flex-col gap-4 relative">
        <div className="flex gap-2 absolute bottom-full left-1/2 -translate-x-1/2 -translate-y-4">
          <Image
            width={40}
            height={40}
            className="w-10 h-10 align-bottom"
            src="/img/logo_dark.svg"
            alt="Logo"
          />
          <h1 className="font-semibold text-3xl mt-1">Beutl</h1>
        </div>
        <Card>
          <CardHeader>
            <CardDescription>{message}</CardDescription>
          </CardHeader>
        </Card>
        <AuthLegalLinks
          lang={lang}
          className="absolute top-full right-0 translate-y-4"
        />
      </div>
    </div>
  );
}
