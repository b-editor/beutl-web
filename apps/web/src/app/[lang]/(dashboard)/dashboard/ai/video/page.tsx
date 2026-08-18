import { getTranslation } from "@beutl/i18n";
import { isVideoModelUsable, loadAiVideoModelCapabilities } from "@beutl/api";
import { authOrSignIn } from "@/lib/auth-guard";
import { AiPageHeader } from "../shared";
import { VideoForm, type AiVideoModelOptions } from "../video-form";
import { getAiScreenState } from "../queries";

export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);
  const [{ access, balance }, capabilities] = await Promise.all([
    getAiScreenState(session.user.id),
    loadAiVideoModelCapabilities(),
  ]);

  // Which parameters a video may carry differs per model, so the screen offers
  // what the chosen one accepts rather than a fixed list that some models
  // refuse. A model that shares no resolution, length or aspect ratio with this
  // service is dropped: every request it could be given would be rejected.
  const registered = access.models["video.generate"] ?? [];
  const usable = registered.filter((model) =>
    isVideoModelUsable(capabilities.get(model.id)),
  );
  // Nothing usable means the capability list is unusable, not that the whole
  // operation is off; leave the registered models in place and let the server
  // explain the refusal.
  const models = usable.length > 0 ? usable : registered;
  const modelOptions: Record<string, AiVideoModelOptions> = Object.fromEntries(
    models.flatMap((model) => {
      const supported = capabilities.get(model.id);
      return supported
        ? [
            [
              model.id,
              {
                resolutions: supported.resolutions,
                durations: supported.durations,
                aspectRatios: supported.aspectRatios,
                generateAudio: supported.generateAudio,
                seed: supported.seed,
              },
            ],
          ]
        : [];
    }),
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
        access={{
          ...access,
          models: { ...access.models, "video.generate": models },
        }}
        capabilities={modelOptions}
      />
    </div>
  );
}
