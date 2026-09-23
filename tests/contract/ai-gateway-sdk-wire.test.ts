import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateGatewayImage, editGatewayImage } from "../../packages/api/src/ai/providers/vercel-gateway/image";
import { startGatewayVideoJob, getGatewayVideoJob } from "../../packages/api/src/ai/providers/vercel-gateway/video";
import { transcribeGatewayAudio } from "../../packages/api/src/ai/providers/vercel-gateway/transcription";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const IMAGE = Uint8Array.from(Buffer.from(PNG, "base64")).buffer;
const VIDEO_REQUEST = {
  model: "spacexai/grok-imagine-video",
  prompt: "The scene continues",
  durationSeconds: 5,
  resolution: "720p",
  aspectRatio: "16:9",
};
const START_RESPONSE = {
  operation: { gatewayJobId: "job_test" },
  providerMetadata: { gateway: { asyncJob: { jobId: "job_test" } } },
};

describe("Gateway requests through the installed SDK", () => {
  const sent: { url: string; body: Record<string, any>; headers: Headers }[] = [];
  beforeEach(() => {
    sent.length = 0;
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "test-gateway-key");
    vi.stubGlobal("fetch", vi.fn(async (url, init: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(init.body as string), headers: new Headers(init.headers) });
      return Response.json(String(url).endsWith("/image-model") ? { images: [PNG] } : START_RESPONSE);
    }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([0, 42, undefined])("keeps image seed %s and reference bytes on the wire", async (seed) => {
    const image = await generateGatewayImage({
      model: "openai/gpt-image-2", prompt: "A lighthouse", aspectRatio: "1:1", seed,
      imageSizeMode: "explicit_1k",
      referenceImages: [{ bytes: IMAGE, mimeType: "image/png" }],
    });
    expect(image).toEqual({ b64Json: PNG, mediaType: "image/png" });
    expect(sent[0].body).toMatchObject({ prompt: "A lighthouse", n: 1, size: "1024x1024" });
    expect(sent[0].body.aspectRatio).toBeUndefined();
    expect(sent[0].body.seed).toBe(seed);
    expect(sent[0].body.files[0]).toMatchObject({ type: "file", data: PNG, mediaType: "image/png" });
  });

  it.each([
    ["1:1", "1024x1024"],
    ["16:9", "2048x1152"],
    ["9:16", "1152x2048"],
    ["4:3", "1408x1056"],
    ["3:4", "1056x1408"],
    ["3:2", "1536x1024"],
    ["2:3", "1024x1536"],
  ] as const)("sends configured ratio %s as explicit size %s", async (aspectRatio, size) => {
    for (const model of ["openai/gpt-image-2", "example/future-image-model"]) {
      await generateGatewayImage({ model, prompt: "A lighthouse", aspectRatio, imageSizeMode: "explicit_1k" });
      expect(sent.at(-1)?.body.size).toBe(size);
      expect(sent.at(-1)?.body.aspectRatio).toBeUndefined();
    }
  });

  it("keeps aspectRatio for models whose provider supports it", async () => {
    await generateGatewayImage({ model: "openai/gpt-image-2", prompt: "A lighthouse", aspectRatio: "16:9" });
    expect(sent[0].body.aspectRatio).toBe("16:9");
    expect(sent[0].body.size).toBeUndefined();
  });

  it("requests a transparent PNG during image generation", async () => {
    await generateGatewayImage({
      model: "openai/gpt-image-2",
      prompt: "A glass marble",
      aspectRatio: "1:1",
      background: "transparent",
    });

    expect(sent[0].body.providerOptions.openai).toEqual({
      background: "transparent",
      outputFormat: "png",
    });
  });

  it.each(["0.05678", "0.0034567800000000000001"])("preserves the actual image charge %s reported by AI Gateway", async (cost) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      images: [PNG],
      providerMetadata: { gateway: { cost } },
    })));

    await expect(generateGatewayImage({
      model: "openai/gpt-image-2",
      prompt: "A marble",
      aspectRatio: "1:1",
    })).resolves.toMatchObject({ providerCostUsd: cost });
  });

  it("carries an image edit source through the SDK", async () => {
    await editGatewayImage({ model: "openai/gpt-image-2", prompt: "Make it blue", task: "restyle", image: IMAGE, mimeType: "image/png" });
    expect(sent[0].body.files[0]).toMatchObject({ data: PNG, mediaType: "image/png" });
    expect(sent[0].body.prompt).toBe("Make it blue");
  });

  it("requests a transparent PNG when removing a background", async () => {
    await editGatewayImage({
      model: "openai/gpt-image-2",
      task: "remove_background",
      image: IMAGE,
      mimeType: "image/png",
    });

    expect(sent[0].body.prompt).toContain("fully transparent background");
    expect(sent[0].body.files[0]).toMatchObject({ data: PNG, mediaType: "image/png" });
    expect(sent[0].body.providerOptions.openai).toEqual({
      background: "transparent",
      outputFormat: "png",
    });
  });

  it.each([0, 42, undefined])("keeps video seed %s, audio=false, callback and idempotency key", async (seed) => {
    expect(await startGatewayVideoJob({
      ...VIDEO_REQUEST, seed, generateAudio: false,
      callbackUrl: "https://example.com/callback", idempotencyKey: "request-1",
    })).toMatchObject({ id: "job_test", status: "pending" });
    expect(sent[0].body).toMatchObject({ resolution: "1280x720", generateAudio: false, callbackUrl: "https://example.com/callback" });
    expect(sent[0].body.seed).toBe(seed);
    expect(sent[0].headers.get("idempotency-key")).toBe("request-1");
  });

  it("logs the Gateway's 402 response type without its sensitive message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: {
        type: "quota_for_entity_exceeded",
        message: "sensitive account and billing detail",
      },
    }, { status: 402 })));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(startGatewayVideoJob(VIDEO_REQUEST)).rejects.toMatchObject({
        httpStatus: 402,
        outcome: "definite_failure",
      });
      expect(warning).toHaveBeenCalledWith("Gateway video submission failed", {
        model: VIDEO_REQUEST.model,
        httpStatus: 402,
        errorType: "GatewayInternalServerError",
        gatewayErrorType: "quota_for_entity_exceeded",
      });
      expect(JSON.stringify(warning.mock.calls)).not.toContain("sensitive account and billing detail");
    } finally {
      warning.mockRestore();
    }
  });

  it("logs only safe fields when Gateway rejects a video submission", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: { message: "secret-response-detail" },
    }, { status: 400 })));

    await expect(startGatewayVideoJob(VIDEO_REQUEST)).rejects.toMatchObject({
      httpStatus: 400,
    });
    expect(warning).toHaveBeenCalledWith("Gateway video submission failed", {
      model: VIDEO_REQUEST.model,
      httpStatus: 400,
      errorType: expect.any(String),
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("secret-response-detail");
    warning.mockRestore();
  });

  it.each(["edit", "extend"] as const)("uses xai options for Grok video %s", async (mode) => {
    await startGatewayVideoJob({ ...VIDEO_REQUEST, mode, sourceVideoUrl: "https://example.com/source.mp4" });
    expect(sent[0].body.providerOptions.xai).toEqual({
      videoUrl: "https://example.com/source.mp4",
      ...(mode === "extend" ? { mode: "extend-video" } : {}),
    });
    expect(sent[0].body.providerOptions.spacexai).toBeUndefined();
  });

  it("keeps Kling motion options and the character image", async () => {
    await startGatewayVideoJob({
      ...VIDEO_REQUEST, model: "klingai/kling-v3.0-motion-control", mode: "motion",
      sourceVideoUrl: "https://example.com/source.mp4", motionQuality: "pro", motionOrientation: "image",
      frameImages: [{ frame_type: "first_frame", image_url: { url: "https://example.com/character.png" } }],
    });
    expect(sent[0].body.providerOptions.klingai).toEqual({ videoUrl: "https://example.com/source.mp4", mode: "pro", characterOrientation: "image" });
    expect(sent[0].body.image).toMatchObject({ type: "url", url: "https://example.com/character.png" });
  });

  it.each(["pending", "completed", "error", "cancelled"])("reads video status %s through the SDK", async (status) => {
    const fetchMock = vi.fn(async () => Response.json({
      status, ...(status === "completed" ? { videos: [{ type: "url", url: "https://example.com/video.mp4", mediaType: "video/mp4" }] } : {}),
      ...(status === "completed" ? { providerMetadata: { gateway: { cost: "0.42" } } } : {}),
      ...(status === "error" ? { error: "failed" } : {}),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const job = await getGatewayVideoJob({ model: VIDEO_REQUEST.model, providerJobId: "job_test" });
    expect(job.status).toBe(status === "error" || status === "cancelled" ? "failed" : status);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ operation: { gatewayJobId: "job_test" } });
  });

  it("reports omitted video cost without logging provider metadata values", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "completed",
      videos: [{ type: "url", url: "https://example.com/video.mp4", mediaType: "video/mp4" }],
      providerMetadata: { gateway: {
        asyncJob: { jobId: "job_test", webhookSigningSecret: "never-log-this" },
      } },
    })));

    const job = await getGatewayVideoJob({ model: VIDEO_REQUEST.model, providerJobId: "job_test" });
    expect(job).toMatchObject({ status: "completed" });
    expect(job).toHaveProperty("result");
    expect(job).not.toHaveProperty("providerCostUsd");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("never-log-this");
    expect(warning).toHaveBeenCalledWith(
      "Gateway video completed without provider cost",
      expect.objectContaining({
        model: VIDEO_REQUEST.model,
        metadataFields: ["gateway"],
        gatewayFields: ["asyncJob"],
        asyncJobFields: ["jobId"],
      }),
    );
    warning.mockRestore();
  });

  it("waits for an asynchronously ingested Gateway charge before completing video", async () => {
    const generationId = "gen_01JQZBWGM1DEMO0123456789AD";
    let lookups = 0;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).includes("/video-model/status")) {
        return Response.json({
          status: "completed",
          videos: [{ type: "url", url: "https://example.com/video.mp4", mediaType: "video/mp4" }],
          providerMetadata: { gateway: { generationId } },
        });
      }
      lookups++;
      return lookups === 1
        ? Response.json({ error: { message: "Usage event not found" } }, { status: 404 })
        : Response.json({ data: { id: generationId, model: VIDEO_REQUEST.model, total_cost: "0.85" } });
    }));

    const ref = { model: VIDEO_REQUEST.model, providerJobId: "job_test" };
    const first = await getGatewayVideoJob(ref);
    expect(first).toMatchObject({ status: "completed" });
    expect(first).toHaveProperty("result");
    expect(first).not.toHaveProperty("providerCostUsd");
    expect(warning.mock.calls.map(([message]) => message))
      .not.toContain("Gateway video generation info fields did not match");

    await expect(getGatewayVideoJob(ref)).resolves.toMatchObject({
      status: "completed",
      providerCostUsd: "0.85",
    });
    expect(lookups).toBe(2);
    warning.mockRestore();
  });

  it("resolves the actual completed-video cost by Gateway generation ID", async () => {
    const generationId = "gen_01JQZBWGM1DEMO0123456789AB";
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      requested.push(String(url));
      if (String(url).includes("/video-model/status")) {
        return Response.json({
          status: "completed",
          videos: [{ type: "url", url: "https://example.com/video.mp4", mediaType: "video/mp4" }],
          providerMetadata: { gateway: { generationId } },
        });
      }
      return Response.json({ data: {
        id: generationId,
        // The catalog calls this creator spacexai; the generation ledger still
        // writes its original xai namespace for the same model and job id.
        model: "xai/grok-imagine-video",
        total_cost: 0.4321,
        upstream_inference_cost: 0,
        usage: 0.4321,
        created_at: "2026-09-23T00:00:00Z",
        is_byok: false,
        provider_name: "test",
        streamed: false,
        finish_reason: "stop",
        latency: 0,
        generation_time: 0,
        native_tokens_prompt: 0,
        native_tokens_completion: 0,
        native_tokens_reasoning: 0,
        native_tokens_cached: 0,
        native_tokens_cache_creation: 0,
        billable_web_search_calls: 0,
      } });
    }));

    await expect(getGatewayVideoJob({ model: VIDEO_REQUEST.model, providerJobId: "job_test" }))
      .resolves.toMatchObject({ status: "completed", providerCostUsd: 0.4321 });
    expect(requested).toHaveLength(2);
    expect(requested[1]).toContain(`/v1/generation?id=${generationId}`);
  });

  it("reads a valid video cost when the SDK rejects absent text metrics", async () => {
    const generationId = "gen_01JQZBWGM1DEMO0123456789AC";
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      requested.push(String(url));
      return String(url).includes("/video-model/status")
        ? Response.json({
            status: "completed",
            videos: [{ type: "url", url: "https://example.com/video.mp4", mediaType: "video/mp4" }],
            providerMetadata: { gateway: { generationId } },
          })
        : Response.json({ data: { id: generationId, model: "xai/grok-imagine-video", total_cost: "0.321234" } });
    }));

    await expect(getGatewayVideoJob({ model: VIDEO_REQUEST.model, providerJobId: "job_test" }))
      .resolves.toMatchObject({ status: "completed", providerCostUsd: "0.321234" });
    expect(requested).toHaveLength(2);
    expect(requested[1]).toContain(`/v1/generation?id=${generationId}`);
  });

  it("rejects a charge from a different creator despite a matching model suffix", async () => {
    const generationId = "gen_01JQZBWGM1DEMO0123456789AE";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (url) =>
      String(url).includes("/video-model/status")
        ? Response.json({
            status: "completed",
            videos: [{ type: "url", url: "https://example.com/video.mp4", mediaType: "video/mp4" }],
            providerMetadata: { gateway: { generationId } },
          })
        : Response.json({ data: {
            id: generationId,
            model: "other/grok-imagine-video",
            total_cost: "0.321234",
          } }),
    ));

    const job = await getGatewayVideoJob({ model: VIDEO_REQUEST.model, providerJobId: "job_test" });
    expect(job).toMatchObject({ status: "completed" });
    expect(job).not.toHaveProperty("providerCostUsd");
    warning.mockRestore();
  });

  it("reads transcription segments and detects the audio format", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(init.body as string), headers: new Headers(init.headers) });
      return Response.json({ text: "Hello", segments: [{ text: "Hello", startSecond: 0, endSecond: 1 }], language: "en", durationInSeconds: 1 });
    }));
    const audio = Uint8Array.from([82, 73, 70, 70, 40, 0, 0, 0, 87, 65, 86, 69]).buffer;
    expect(await transcribeGatewayAudio({ model: "openai/whisper-1", audio, durationSeconds: 1, filename: "audio.wav", mimeType: "audio/wav" }))
      .toMatchObject({ language: "en", segments: [{ start: 0, end: 1, text: "Hello" }] });
    expect(sent[0].body.mediaType).toBe("audio/wav");
    expect(sent[0].body.audio).toBe(Buffer.from(audio).toString("base64"));
  });
});
