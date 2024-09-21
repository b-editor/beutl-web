import authOrSignIn from "@/lib/auth-guard";
import { prisma } from "@/prisma";
import { Form } from "./components";
import { updateEmail } from "./actions";

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
      <Form email={user.email} className="mt-4" emailUpdated={emailUpdated} />
    </div>
  )
}