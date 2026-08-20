import { getTranslation } from "@beutl/i18n";
import {
  isImageModelUsable,
  loadAiImageModelCapabilities,
} from "@beutl/api";
import { authOrSignIn } from "@/lib/auth-guard";
import { AiPageHeader } from "../shared";
import {
  ImageGenerateForm,
  type AiImageModelOptions,
} from "../image-generate-form";
import { getAiScreenState } from "../queries";

export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);
  const { access, balance } = await getAiScreenState(session.user.id);
  // Which shapes a model takes differs per model — GPT Image-1 renders 1:1,
  // 3:2 and 2:3 and refuses the rest — so the screen offers what the chosen one
  // accepts rather than a fixed set the provider then rejects.
  const registered = access.models["image.generate"] ?? [];
  const capabilities = await loadAiImageModelCapabilities(
    registered.map((model) => model.id),
  );
  const usable = registered.filter((model) =>
    isImageModelUsable(capabilities.get(model.id)),
  );
  // 使えるモデルがひとつも無いのは、能力が読めなかったからではない（読めなければ
  // 制限なしとして全部残る）。登録済みを戻すと、必ず拒否される送信を許すことになる。
  const models = usable;
  const modelOptions: Record<string, AiImageModelOptions> = Object.fromEntries(
    models.flatMap((model) => {
      const supported = capabilities.get(model.id);
      return supported
        ? [
            [
              model.id,
              {
                aspectRatios: supported.aspectRatios,
                backgrounds: supported.backgrounds,
                seed: supported.seed,
                maxReferenceImages: supported.maxReferenceImages,
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
        title={t("dashboard:ai.imageGeneration")}
        description={t("dashboard:ai.imageGenerationDescription")}
        balance={balance}
      />
      <ImageGenerateForm
        lang={lang}
        access={{
          ...access,
          models: { ...access.models, "image.generate": models },
        }}
        capabilities={modelOptions}
      />
    </div>
  );
}
