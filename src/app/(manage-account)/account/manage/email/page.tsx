import { authOrSignIn } from "@/lib/auth-guard";
import { prisma } from "@/prisma";
import { Form } from "./components";
import { updateEmail } from "./actions";
import { Separator } from "@/components/ui/separator";

export default async function Page({ searchParams: { token, identifier, emailUpdated } }: { searchParams: { token?: string, identifier?: string, emailUpdated?: boolean } }) {
  const session = await authOrSignIn();
  if (token && identifier) {
    updateEmail(token, identifier);
  }

  const user = await prisma.user.findFirst({
    where: {
      id: session.user.id,
    },
  });
  if (!user) {
    throw new Error("ユーザーが見つかりませんでした");
  }

  return (
    <div>
      <h2 className="font-bold text-2xl">メールアドレス</h2>

      <div className="mt-4 rounded-lg border text-card-foreground">
        <h2 className="font-bold text-md m-6 mb-4">メールアドレスを変更</h2>
        <Separator />
        <Form email={user.email} className="mx-6 mt-4 mb-0" emailUpdated={emailUpdated} />
      </div>
    </div>
  )
}