import { getTranslation } from "@beutl/i18n";
import { authOrSignIn } from "@/lib/auth-guard";
import { AiPageHeader } from "../shared";
import { VideoForm } from "../video-form";
import { getAiScreenState } from "../queries";
import { buildAiVideoScreenOptions } from "../video-options";

export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);
  const {
    access,
    balance,
    videoCapabilities: capabilities,
  } = await getAiScreenState(session.user.id);

  const { models, modelOptions } = buildAiVideoScreenOptions(
    access,
    capabilities,
  );

  return (
    <div className="flex flex-col gap-6">
      <AiPageHeader
        lang={lang}
        title={t("dashboard:ai.videoGeneration")}
        description={t("dashboard:ai.videoGenerationDescription")}
        balance={balance}
      />
      <VideoForm
        lang={lang}
        userId={session.user.id}
        access={{
          ...access,
          models: { ...access.models, "video.generate": models },
        }}
        capabilities={modelOptions}
      />
    </div>
  );
}
