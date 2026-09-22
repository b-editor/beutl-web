import "server-only";
import { cache } from "react";
import { getDb, listAiOperationModels, listPackagePaymentRefundInterventions, listStorageMultipartInterventions, listStorageUploadInterventions, listTopUpCheckoutInterventions } from "@beutl/db";
import {
  imageCapabilityOf,
  isImageModelUsable,
  unusableVideoModelsFor,
  loadAiImageModelCapabilities,
  loadAiModelCatalog,
  loadAiSettings,
  loadAiVideoModelCapabilities,
} from "@beutl/api";
import { deriveTopUpUnitValue } from "@beutl/core";
import { resolveOfferPricing } from "@/lib/stripe-pricing";

export const getAiSettings = cache(async () => await loadAiSettings());

// The rows an administrator registered, exactly as stored. The page edits these
// rather than the resolved catalog, so an operation with none shows an empty
// list rather than the built-in fallback pretending to be a row.
export const getAiOperationModels = cache(
  async () => await listAiOperationModels(),
);
export const getStorageMultipartInterventions = cache(async () => await listStorageMultipartInterventions());
export const getStorageUploadInterventions = cache(async () => await listStorageUploadInterventions());
export const getTopUpCheckoutInterventions = cache(async () => await listTopUpCheckoutInterventions());
export const getPackagePaymentRefundInterventions = cache(
  async (page: number, pageSize: number) =>
    await listPackagePaymentRefundInterventions({ page, pageSize }),
);

// The video models that cannot serve a single request the operation they are
// registered for can build.
//
// Which resolutions, lengths and aspect ratios a video model takes differs per
// model, and one that shares none with this service is registered but dead: the
// provider refuses everything it is sent. Nothing else on this page would show
// that, and on the user's screen it reads as a provider outage.
//
// Per operation, because what makes a model usable differs between them. A
// motion-control model offers no text-to-video at all, which makes it useless
// for a generation and is exactly what video.motion needs; asking the
// generation question about every row condemned the one model that operation
// has.
export const getUnusableVideoModels = cache(
  async (
    operation: string,
    // Who runs a model decides what it takes, so the rows come through whole.
    models: readonly { modelId: string; provider: string }[],
  ) => {
    return unusableVideoModelsFor(
      operation,
      models,
      await loadAiVideoModelCapabilities(),
    );
  },
);

// The image models that cannot serve the operation they are registered for.
//
// Which shapes an image model takes differs per model: GPT Image-1 renders
// 1:1, 3:2 and 2:3 and refuses everything else, and only some take a picture to
// work from — which every edit depends on. Nothing else on this page would show
// that, and on the user's screen it reads as a provider outage.
export const getUnusableImageModels = cache(
  async (
    operation: string,
    // Who runs a model decides what it takes, so the rows come through whole.
    models: readonly { modelId: string; provider: string }[],
  ) => {
    const capabilities = await loadAiImageModelCapabilities(models);
    const isEdit = operation.startsWith("image.edit.");
    // Model ids are returned bare, which stays unambiguous: the catalog keys a
    // row by (operation, modelId), so one operation never holds the same id
    // twice.
    return new Set(
      models
        .filter(
          (model) =>
            !isImageModelUsable(imageCapabilityOf(capabilities, model), {
              referenceImages: isEdit,
              resolution: operation === "image.edit.upscale",
              background: operation === "image.edit.remove_background"
                ? "transparent"
                : undefined,
            }),
        )
        .map((model) => model.modelId),
    );
  },
);

// What each operation can actually run on, fallback included.
export const getAiModelCatalog = cache(async () => await loadAiModelCatalog());

// Offer prices go over the network, so the cards sit behind a Suspense boundary.
export const getAiEconomics = cache(async () => {
  // Explicitly share the render-scoped client across both offer reads.
  const prisma = await getDb();
  const [pro, topUp] = await Promise.all([
    resolveOfferPricing({ kind: "pro", prisma }),
    resolveOfferPricing({ kind: "top_up", prisma }),
  ]);

  return {
    pro,
    topUp,
    topUpUnitValue: deriveTopUpUnitValue(topUp.effective),
  };
});
