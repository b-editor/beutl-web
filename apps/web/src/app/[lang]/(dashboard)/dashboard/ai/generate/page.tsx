import { getTranslation } from "@beutl/i18n";
import { authOrSignIn } from "@/lib/auth-guard";
import { AiPageHeader } from "../shared";
import { ImageGenerateForm } from "../image-generate-form";
import { getAiScreenState } from "../queries";

export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);
  const { access, balance } = await getAiScreenState(session.user.id);

  return (
    <div className="flex flex-col gap-6">
      <AiPageHeader
        lang={lang}
        title={t("dashboard:ai.imageGeneration")}
        description={t("dashboard:ai.imageGenerationDescription")}
        balance={balance}
      />
      <ImageGenerateForm lang={lang} access={access} />
    </div>
  );
}
