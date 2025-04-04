import { Form, List, PasskeysList } from "./components";
import { authOrSignIn } from "@/lib/auth-guard";
import * as jose from "jose";
import type { SignInPageErrorParam } from "@auth/core/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { translateNextAuthError } from "@/lib/error-description";
import type { ComponentProps } from "react";
import { Separator } from "@/components/ui/separator";
import { getTranslation } from "@/app/i18n/server";
import { retrieveAccountsWithIdToken } from "@/lib/db/account";
import { findAuthenticatorByAccountId } from "@/lib/db/authenticator";

export default async function Page(
  props: {
    searchParams: Promise<{ error?: SignInPageErrorParam }>;
    params: Promise<{ lang: string }>;
  }
) {
  const params = await props.params;

  const {
    lang
  } = params;

  const searchParams = await props.searchParams;

  const {
    error
  } = searchParams;

  const session = await authOrSignIn();

  const accounts = await retrieveAccountsWithIdToken({
    userId: session.user.id,
  });
  const safeAccounts = await Promise.all(
    accounts.map(async (account) => {
      let emailOrUserName: string | undefined;
      if (account.id_token) {
        const payload = jose.decodeJwt(account.id_token);
        emailOrUserName = payload.email as string;
      }
      if (!emailOrUserName && account.provider === "github") {
        try {
          const res = await fetch(
            `https://api.github.com/user/${account.providerAccountId}`,
            {
              headers: {
                Authorization: `Bearer ${process.env.GITHUB_PAT}`,
              },
            },
          );

          emailOrUserName = (await res.json()).login;
        } catch {}
      }
      return {
        provider: account.provider,
        providerAccountId: account.providerAccountId,
        emailOrUserName,
      };
    }),
  );
  const authenticators = (
    await Promise.all(
      accounts
        .filter((i) => i.provider === "passkey")
        .map(async (account) => {
          const authenticator = await findAuthenticatorByAccountId({
            providerAccountId: account.providerAccountId,
          });
          if (!authenticator) return null;
          return {
            id: authenticator.credentialID,
            deviceType: authenticator.credentialDeviceType,
            backedUp: authenticator.credentialBackedUp,
            name: authenticator.name,
            createdAt: authenticator.createdAt,
            usedAt: authenticator.usedAt,
          };
        }),
    )
  ).filter((i) => i) as ComponentProps<typeof PasskeysList>["authenticators"];
  const { t } = await getTranslation(lang);

  return (
    <div>
      <h2 className="font-bold text-2xl">{t("account:security.title")}</h2>

      <div className="mt-4 rounded-lg border text-card-foreground">
        <h3 className="font-bold text-md m-6 mb-4">
          {t("account:security.addSignInMethod")}
        </h3>
        <Separator />
        <Form className="py-4 px-6" lang={lang} />
      </div>

      {error && (
        <Alert variant="destructive" className="mt-2">
          <AlertTitle>{t("error")}</AlertTitle>
          <AlertDescription>
            {translateNextAuthError(t, error)}
          </AlertDescription>
        </Alert>
      )}

      <div className="mt-4 rounded-lg border text-card-foreground">
        <h3 className="font-bold text-md m-6 mb-4">
          {t("account:security.linkedAccounts")}
        </h3>
        <Separator />
        <List lang={lang} accounts={safeAccounts} />
        {authenticators.length !== 0 && <Separator />}
        <PasskeysList lang={lang} authenticators={authenticators} />
      </div>
    </div>
  );
}
