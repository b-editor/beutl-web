import { authOrSignIn } from "@/lib/auth-guard";
import { getDb } from "@/prisma";
import { Form } from "./components";
import { ConfirmationTokenPurpose } from "@prisma/client";
import { Separator } from "@/components/ui/separator";
import { getTranslation } from "@/app/i18n/server";
import { findEmailByUserId } from "@/lib/db/user";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const params = await props.params;

  const {
    lang
  } = params;

  const session = await authOrSignIn();

  const user = await findEmailByUserId({ userId: session.user.id });
  if (!user) {
    throw new Error("User not found");
  }
  const prisma = getDb();
  const tokens = await prisma.confirmationToken.findMany({
    where: {
      userId: session.user.id,
      purpose: ConfirmationTokenPurpose.ACCOUNT_DELETE,
    },
  });
  const { t } = await getTranslation(lang);

  return (
    <div>
      <h2 className="font-bold text-2xl">{t("account:data.title")}</h2>

      <div className="mt-4 rounded-lg border text-card-foreground">
        <h2 className="font-bold text-md m-6 mb-4">
          {t("account:data.deleteAccount")}
        </h2>
        <Separator />
        <Form
          lang={lang}
          email={user.email}
          className="mx-6 mt-4"
          cancelable={tokens.some((i) => i.expires.valueOf() >= Date.now())}
        />
      </div>
    </div>
  );
}
