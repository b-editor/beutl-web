import { Form, List, PasskeysList } from "./components";
import { authOrSignIn } from "@/lib/auth-guard";
import * as jose from "jose";
import type { ComponentProps } from "react";
import { Separator } from "@beutl/ui/ui/separator";
import { getTranslation } from "@beutl/i18n";
import { retrieveAccountsWithIdToken } from "@beutl/db";
import { getPasskeysByUserId } from "@beutl/db";

export default async function Page(
  props: {
    params: Promise<{ lang: string }>;
  }
) {
  const params = await props.params;

  const {
    lang
  } = params;

  const session = await authOrSignIn();

  // Better Auth: accounts use providerId and accountId
  const accounts = await retrieveAccountsWithIdToken({
    userId: session.user.id,
  });
  const safeAccounts = await Promise.all(
    accounts.map(async (account) => {
      let emailOrUserName: string | undefined;
      if (account.idToken) {
        const payload = jose.decodeJwt(account.idToken);
        emailOrUserName = payload.email as string;
      }
      if (!emailOrUserName && account.providerId === "github") {
        try {
          const res = await fetch(
            `https://api.github.com/user/${account.accountId}`,
            {
              headers: {
                Authorization: `Bearer ${process.env.GITHUB_PAT}`,
              },
            },
          );

          emailOrUserName = (await res.json()).login;
        } catch (err) {
          console.error("Failed to fetch GitHub username", err);
        }
      }
      return {
        providerId: account.providerId,
        accountId: account.accountId,
        emailOrUserName,
      };
    }),
  );

  // Better Auth: Passkeys are stored in a separate table
  const passkeys = await getPasskeysByUserId({ userId: session.user.id });
  const passkeysList = passkeys.map((passkey) => ({
    id: passkey.credentialID,
    deviceType: passkey.deviceType as "singleDevice" | "multiDevice",
    backedUp: passkey.backedUp,
    name: passkey.name ?? "Unnamed",
    createdAt: passkey.createdAt,
    usedAt: passkey.usedAt ?? passkey.createdAt,
  })) as ComponentProps<typeof PasskeysList>["authenticators"];

  const { t } = await getTranslation(lang);

  return (
    <div>
      <h1 className="text-2xl font-bold">{t("account:security.title")}</h1>

      <div className="mt-4 rounded-lg border text-card-foreground">
        <h3 className="font-bold text-md m-6 mb-4">
          {t("account:security.addSignInMethod")}
        </h3>
        <Separator />
        <Form className="py-4 px-6" lang={lang} />
      </div>

      <div className="mt-4 rounded-lg border text-card-foreground">
        <h3 className="font-bold text-md m-6 mb-4">
          {t("account:security.linkedAccounts")}
        </h3>
        <Separator />
        <List lang={lang} accounts={safeAccounts} />
        {passkeysList.length !== 0 && <Separator />}
        <PasskeysList lang={lang} authenticators={passkeysList} />
      </div>
    </div>
  );
}
