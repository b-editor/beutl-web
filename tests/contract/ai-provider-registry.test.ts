import { beforeEach, describe, expect, it, vi } from "vitest";

const createVideoJob = vi.hoisted(() => vi.fn());
const getVideoJob = vi.hoisted(() => vi.fn());
const listVideoModels = vi.hoisted(() => vi.fn());
vi.mock("../../packages/api/src/ai/openrouter-video", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../packages/api/src/ai/openrouter-video")
  >();
  return { ...actual, createVideoJob, getVideoJob, listVideoModels };
});

const downloadVideoContent = vi.hoisted(() => vi.fn());
vi.mock("../../packages/api/src/ai/openrouter", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../packages/api/src/ai/openrouter")
  >();
  return { ...actual, downloadVideoContent };
});

import { AI_OPERATIONS } from "@beutl/core";
import { AiProviderError } from "../../packages/api/src/ai/providers/errors";
import {
  DEFAULT_AI_PROVIDER_ID,
  findAiProvider,
  listAiProviders,
  providerFor,
  providerSupportsOperation,
  videoProviderFor,
} from "../../packages/api/src/ai/providers/registry";

describe("resolving a provider", () => {
  it("answers for the provider every existing row carries", () => {
    expect(DEFAULT_AI_PROVIDER_ID).toBe("openrouter");
    expect(providerFor(DEFAULT_AI_PROVIDER_ID).id).toBe("openrouter");
    expect(listAiProviders().map((provider) => provider.id)).toContain(
      "openrouter",
    );
  });

  it("refuses an id it does not implement", () => {
    // A job row holds whatever string was written to it. An id with no
    // implementation has to fail here, once, rather than at whichever call site
    // is reached first.
    expect(findAiProvider("nonesuch")).toBeNull();
    expect(() => providerFor("nonesuch")).toThrow(AiProviderError);
    expect(() => providerFor("nonesuch")).toThrow(
      "Unsupported AI provider: nonesuch",
    );
  });

  it("serves Vercel AI Gateway for the operations it can run", () => {
    expect(findAiProvider("vercel-gateway")?.id).toBe("vercel-gateway");
    for (const operation of [
      "video.generate",
      "image.generate",
      "image.edit.restyle",
      "image.edit.remove_object",
      "audio.transcribe",
      "subtitle.translate",
    ]) {
      expect(providerSupportsOperation("vercel-gateway", operation)).toBe(true);
    }
  });

  it("refuses the edits Vercel AI Gateway has no surface for", () => {
    // The Gateway has no named operation for background removal, upscaling or
    // outpainting; OpenRouter serves them through provider parameters with no
    // counterpart, and a mask cannot address anything outside the source frame.
    // Saying so here is what stops a model being registered for one and failing
    // only after the user has been charged.
    for (const operation of [
      "image.edit.remove_background",
      "image.edit.upscale",
      "image.edit.outpaint",
    ]) {
      expect(providerSupportsOperation("vercel-gateway", operation)).toBe(false);
      // OpenRouter still serves all three, so the catalog keeps them offered.
      expect(providerSupportsOperation("openrouter", operation)).toBe(true);
    }
  });

  it("says which operations a provider can actually run", () => {
    for (const operation of AI_OPERATIONS) {
      // The three that work from a video this service already holds are the
      // exception: OpenRouter's video API has no field for a source video.
      expect(providerSupportsOperation("openrouter", operation)).toBe(
        !["video.edit", "video.extend", "video.motion"].includes(operation),
      );
    }
    expect(providerSupportsOperation("openrouter", "video.extend")).toBe(false);
    expect(providerSupportsOperation("vercel-gateway", "video.extend")).toBe(
      true,
    );
    expect(providerSupportsOperation("nonesuch", "video.generate")).toBe(false);
  });
});

describe("the video half of a provider", () => {
  beforeEach(() => {
    createVideoJob.mockReset();
    getVideoJob.mockReset();
    listVideoModels.mockReset();
    downloadVideoContent.mockReset();
  });

  it("addresses a job by id, ignoring the model OpenRouter has no use for", async () => {
    getVideoJob.mockResolvedValue({ id: "job_1", status: "completed" });

    await expect(
      videoProviderFor("openrouter").status({
        providerJobId: "job_1",
        model: "google/veo-3.1",
      }),
    ).resolves.toEqual({ id: "job_1", status: "completed" });
    expect(getVideoJob).toHaveBeenCalledWith("job_1");
  });

  it("downloads from the local record's job id rather than the reply's", async () => {
    // The local row owns the identifier the money is attached to; a reply that
    // named a different job must not be what gets fetched and saved.
    downloadVideoContent.mockResolvedValue({
      bytes: new ArrayBuffer(0),
      mimeType: "video/mp4",
      extension: "mp4",
    });

    await videoProviderFor("openrouter").download(
      { id: "job_from_reply", status: "completed" },
      { providerJobId: "job_on_record", model: null },
    );

    expect(downloadVideoContent).toHaveBeenCalledWith("job_on_record");
  });

  it("passes a submission through unchanged", async () => {
    createVideoJob.mockResolvedValue({ id: "job_2", status: "pending" });
    const request = {
      prompt: "a corgi",
      durationSeconds: 4,
      resolution: "720p" as const,
      model: "google/veo-3.1",
    };

    await videoProviderFor("openrouter").start(request);

    expect(createVideoJob).toHaveBeenCalledWith(request);
  });

  it("reports a provider that generates no video", () => {
    expect(() => videoProviderFor("nonesuch")).toThrow(AiProviderError);
  });
});
