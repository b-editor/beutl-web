import { prisma } from "@/prisma";
import { Form, List } from "./components";
import authOrSignIn from "@/lib/auth-guard";
import * as jose from 'jose';
import type { SignInPageErrorParam } from "@auth/core/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { translateNextAuthError } from "@/lib/error-description";

export default async function Page({
  searchParams: {
    error
  }
}: {
  searchParams: {
    error?: SignInPageErrorParam
  }
}) {
  const session = await authOrSignIn();

  const accounts = await prisma.account.findMany({
    where: {
      userId: session.user.id
    },
    select: {
      providerAccountId: true,
      provider: true,
      id_token: true,
    }
  });
  const safeAccounts = await Promise.all(accounts.map(async (account) => {
    let emailOrUserName: string | undefined;
    if (account.id_token) {
      const payload = jose.decodeJwt(account.id_token);
      emailOrUserName = payload.email as string;
    }
    if (!emailOrUserName && account.provider === "github") {
      try {
        const res = await fetch(`https://api.github.com/user/${account.providerAccountId}`, {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_PAT}`
          }
        });

        emailOrUserName = (await res.json()).login;
      } catch {
      }
    }
    return ({
      provider: account.provider,
      providerAccountId: account.providerAccountId,
      emailOrUserName,
    });
  }));

  return (
    <div>
      <h2 className="font-bold text-2xl">セキュリティ</h2>
      <h3 className="font-bold text-md mt-4">外部アカウント</h3>
      <Form accounts={safeAccounts} className="mt-2" />
      {error && (
        <Alert variant="destructive" className="mt-2">
          <AlertTitle>エラー</AlertTitle>
          <AlertDescription>{translateNextAuthError(error)}</AlertDescription>
        </Alert>
      )}
      <h3 className="font-bold text-md mt-4">リンク済み</h3>
      <List className="mt-2" accounts={safeAccounts} />

    </div>
  )
}