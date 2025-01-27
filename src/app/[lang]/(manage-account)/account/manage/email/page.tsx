import { authOrSignIn } from "@/lib/auth-guard";
import { Form } from "./components";
import { updateEmail } from "./actions";
import { Separator } from "@/components/ui/separator";
import { getTranslation } from "@/app/i18n/server";
import { findEmailByUserId } from "@/lib/db/user";

export default async function Page({
  searchParams: { token, identifier, status },
  params: { lang },
}: {
  searchParams: {
    token?: string;
    identifier?: string;
    status?: "emailUpdated" | "emailExists" | "emailUpdateFailed";
  };
  params: { lang: string };
}) {
  const session = await authOrSignIn();
  if (token && identifier) {
    await updateEmail(token, identifier);
  }

  const user = await findEmailByUserId({ userId: session.user.id });
  if (!user) {
    throw new Error("User not found");
  }
  const { t } = await getTranslation(lang);

  return (
    <div>
      <h2 className="font-bold text-2xl">{t("account:email.title")}</h2>

      <div className="mt-4 rounded-lg border text-card-foreground">
        <h2 className="font-bold text-md m-6 mb-4">
          {t("account:email.changeEmail")}
        </h2>
        <Separator />
        <Form
          email={user.email}
          className="mx-6 mt-4 mb-0"
          status={status}
          lang={lang}
        />
      </div>
    </div>
  );
}
