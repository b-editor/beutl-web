import authOrSignIn from "@/lib/auth-guard";
import { prisma } from "@/prisma";
import { Form } from "./components";
import { ConfirmationTokenPurpose } from "@prisma/client";

export default async function Page() {
  const session = await authOrSignIn();

  const user = await prisma.user.findFirst({
    where: {
      id: session.user.id,
    },
  });
  if (!user) {
    throw new Error("ユーザーが見つかりませんでした");
  }
  const tokens = await prisma.confirmationToken.findMany({
    where: {
      userId: session.user.id,
      purpose: ConfirmationTokenPurpose.ACCOUNT_DELETE,
    }
  });

  return (
    <div>
      <h2 className="font-bold text-2xl">アカウントを削除</h2>
      <Form email={user.email} className="mt-4" cancelable={tokens.some((i) => i.expires.valueOf() >= Date.now())} />
    </div>
  )
}