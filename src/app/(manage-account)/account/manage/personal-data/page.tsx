import authOrSignIn from "@/lib/auth-guard";
import { prisma } from "@/prisma";
import { Form } from "./components";
import { ConfirmationTokenPurpose } from "@prisma/client";
import { Separator } from "@/components/ui/separator";

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
      <h2 className="font-bold text-2xl">個人情報</h2>

      <div className="mt-4 rounded-lg border text-card-foreground">
        <h2 className="font-bold text-md m-6 mb-4">アカウントを削除</h2>
        <Separator />
        <Form email={user.email} className="mx-6 mt-4" cancelable={tokens.some((i) => i.expires.valueOf() >= Date.now())} />
      </div>
    </div>
  )
}