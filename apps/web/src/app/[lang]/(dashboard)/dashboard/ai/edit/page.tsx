import { getTranslation } from "@beutl/i18n";
import { AI_IMAGE_EDIT_TASKS } from "@beutl/core";
import {
  isImageModelUsable,
  loadAiImageModelCapabilities,
} from "@beutl/api";
import { authOrSignIn } from "@/lib/auth-guard";
import { AiPageHeader } from "../shared";
import { ImageEditForm } from "../image-edit-form";
import { getAiScreenState } from "../queries";

export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);
  const { access, balance } = await getAiScreenState(session.user.id);
  // Every edit hands the model a picture, and upscaling asks it for a size. A
  // model that takes neither is registered and unusable: each request it is
  // given would be refused after the usage was reserved.
  const operations = AI_IMAGE_EDIT_TASKS.map((task) => `image.edit.${task}`);
  const capabilities = await loadAiImageModelCapabilities(
    operations.flatMap((operation) =>
      (access.models[operation] ?? []).map((model) => model.id),
    ),
  );
  const models = Object.fromEntries(
    operations.map((operation) => {
      const registered = access.models[operation] ?? [];
      const usable = registered.filter((model) =>
        isImageModelUsable(capabilities.get(model.id), {
          referenceImages: true,
          resolution: operation === "image.edit.upscale",
        }),
      );
      return [operation, usable.length > 0 ? usable : registered];
    }),
  );

  return (
    <div className="flex flex-col gap-6">
      <AiPageHeader
        lang={lang}
        title={t("dashboard:ai.imageEdit")}
        description={t("dashboard:ai.imageEditDescription")}
        balance={balance}
      />
      <ImageEditForm
        lang={lang}
        access={{ ...access, models: { ...access.models, ...models } }}
      />
    </div>
  );
}
