import { authOrSignIn } from "@/lib/auth-guard";
import { Form } from "./components";
import { updateEmail } from "./actions";
import { Separator } from "@beutl/ui/ui/separator";
import { getTranslation } from "@beutl/i18n";
import { findEmailByUserId } from "@beutl/db";

export default async function Page(
  props: {
    searchParams: Promise<{
      token?: string;
      identifier?: string;
      status?: "emailUpdated" | "emailExists" | "emailUpdateFailed";
    }>;
    params: Promise<{ lang: string }>;
  }
) {
  const params = await props.params;

  const {
    lang
  } = params;

  const searchParams = await props.searchParams;

  const {
    token,
    identifier,
    status
  } = searchParams;

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
      <h1 className="text-2xl font-bold">{t("account:email.title")}</h1>

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
