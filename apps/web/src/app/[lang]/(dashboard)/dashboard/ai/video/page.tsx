import { getTranslation } from "@beutl/i18n";
import { loadAiVideoModelCapabilities } from "@beutl/api/ai/video-model-capabilities";
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
  // Both consumers need the same provider snapshot. Keep this promise scoped
  // to the render: module-global in-flight I/O cannot safely cross Cloudflare
  // Worker request contexts.
  const capabilitiesPromise = loadAiVideoModelCapabilities();
  const [{ access, balance }, capabilities] = await Promise.all([
    getAiScreenState(session.user.id, {
      videoCapabilities: capabilitiesPromise,
    }),
    capabilitiesPromise,
  ]);

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
