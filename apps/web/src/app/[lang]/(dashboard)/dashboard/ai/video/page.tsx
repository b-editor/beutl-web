import { getTranslation } from "@beutl/i18n";
import { authOrSignIn } from "@/lib/auth-guard";
import { getEntitlements } from "@beutl/api";
import { AiPageHeader, VideoForm } from "../components";

export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);
  const entitlements = await getEntitlements(session.user.id);

  return (
    <div className="flex flex-col gap-6">
      <AiPageHeader
        lang={lang}
        title={t("dashboard:ai.videoGeneration")}
        description={t("dashboard:ai.videoGenerationDescription")}
      />
      <VideoForm lang={lang} canUseAi={entitlements.canUseAi} />
    </div>
  );
}
