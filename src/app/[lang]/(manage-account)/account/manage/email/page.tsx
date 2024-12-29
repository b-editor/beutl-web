import { authOrSignIn } from "@/lib/auth-guard";
import { prisma } from "@/prisma";
import { Form } from "./components";
import { updateEmail } from "./actions";
import { Separator } from "@/components/ui/separator";
import { getTranslation } from "@/app/i18n/server";

export default async function Page({
  searchParams: { token, identifier, emailUpdated },
  params: { lang },
}: {
  searchParams: { token?: string, identifier?: string, emailUpdated?: boolean },
  params: { lang: string },
}) {
  const session = await authOrSignIn();
  if (token && identifier) {
    await updateEmail(token, identifier);
  }

  const user = await prisma.user.findFirst({
    where: {
      id: session.user.id,
    },
  });
  if (!user) {
    throw new Error("User not found");
  }
  const { t } = await getTranslation(lang)

  return (
    <div>
      <h2 className="font-bold text-2xl">{t("account:email.title")}</h2>

      <div className="mt-4 rounded-lg border text-card-foreground">
        <h2 className="font-bold text-md m-6 mb-4">{t("account:email.changeEmail")}</h2>
        <Separator />
        <Form email={user.email} className="mx-6 mt-4 mb-0" emailUpdated={emailUpdated} lang={lang} />
      </div>
    </div>
  )
}