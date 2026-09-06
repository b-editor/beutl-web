import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVideoJob,
  getVideoJob,
  listVideoModels,
} from "../../packages/api/src/ai/openrouter-video";
import type { AiVideoSubmissionError } from "../../packages/api/src/ai/openrouter";

// The video endpoints go through OpenRouter's official SDK. What is pinned here
// is what this service depends on and the SDK does not promise on its own: the
// request the provider receives, that a submission is never retried, and which
// failures may be refunded.

const CALLBACK_URL =
  "https://beutl.example/api/v3/ai/videos/local-1/openrouter-callback";

const SUBMISSION = {
  prompt: "ocean waves",
  durationSeconds: 4,
  resolution: "720p" as const,
  callbackUrl: CALLBACK_URL,
  model: "google/veo-3.1",
};

function accepted(body: Record<string, unknown>, status = 202): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: "submission" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function sentRequest(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const request = fetchMock.mock.calls[call]?.[0] as Request;
  return { url: request.url, body: await request.json() };
}

describe("OpenRouter video client contract", () => {
  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("submits the documented request and returns the accepted job", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      accepted({
        id: "video-1",
        polling_url: "https://openrouter.ai/api/v1/videos/video-1",
        status: "pending",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createVideoJob({ ...SUBMISSION, resolution: "1080p" }),
    ).resolves.toEqual({
      id: "video-1",
      status: "pending",
      unsignedUrls: undefined,
      error: null,
    });

    const { url, body } = await sentRequest(fetchMock);
    expect(url).toBe("https://openrouter.ai/api/v1/videos");
    expect(body).toEqual({
      model: "google/veo-3.1",
      prompt: "ocean waves",
      duration: 4,
      resolution: "1080p",
      callback_url: CALLBACK_URL,
    });
  });

  it("asks for a vertical silent clip when the request says so", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      accepted({ id: "vid-shape", polling_url: "/x", status: "pending" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createVideoJob({
      ...SUBMISSION,
      aspectRatio: "9:16",
      generateAudio: false,
      seed: 11,
    });

    expect((await sentRequest(fetchMock)).body).toMatchObject({
      aspect_ratio: "9:16",
      generate_audio: false,
      seed: 11,
    });
  });

  it("omits the shape fields a request does not set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      accepted({ id: "vid-plain", polling_url: "/x", status: "pending" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createVideoJob(SUBMISSION);

    const { body } = await sentRequest(fetchMock);
    expect(body).not.toHaveProperty("aspect_ratio");
    expect(body).not.toHaveProperty("generate_audio");
    expect(body).not.toHaveProperty("seed");
  });

  it("sends first and last frame images with the documented frame types", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      accepted({ id: "video-frames-1", polling_url: "/x", status: "pending" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createVideoJob({
      ...SUBMISSION,
      durationSeconds: 6,
      frameImages: [
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AQID" },
          frame_type: "first_frame",
        },
        {
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,BAUG" },
          frame_type: "last_frame",
        },
      ],
    });

    expect((await sentRequest(fetchMock)).body).toMatchObject({
      frame_images: [
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AQID" },
          frame_type: "first_frame",
        },
        {
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,BAUG" },
          frame_type: "last_frame",
        },
      ],
    });
  });

  it("submits without a callback when the deployment has no HTTPS origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      accepted({ id: "vid-nocb", polling_url: "/x", status: "pending" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // A local server cannot be called back on, and refusing the submission for
    // it made video generation impossible to run there. The poll path finishes
    // these instead.
    await createVideoJob({
      prompt: "ocean waves",
      durationSeconds: 4,
      resolution: "720p",
      model: "google/veo-3.1",
    });

    expect((await sentRequest(fetchMock)).body).not.toHaveProperty(
      "callback_url",
    );
  });

  it("rejects a callback URL the provider would not call before submitting", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const callbackUrl of ["http://beutl.example/callback", "not a url"]) {
      await expect(
        createVideoJob({ ...SUBMISSION, callbackUrl }),
      ).rejects.toMatchObject({
        name: "AiVideoSubmissionError",
        outcome: "definite_failure",
      } satisfies Partial<AiVideoSubmissionError>);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies an already-aborted request as unsent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort(new DOMException("page reloaded", "AbortError"));

    await expect(
      createVideoJob({ ...SUBMISSION, signal: controller.signal }),
    ).rejects.toMatchObject({
      name: "AiVideoSubmissionError",
      outcome: "definite_failure",
    } satisfies Partial<AiVideoSubmissionError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, "definite_failure"],
    [500, "unknown"],
  ] as const)(
    "classifies a video submission HTTP %s response as %s",
    async (status, outcome) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(status)));

      await expect(createVideoJob(SUBMISSION)).rejects.toMatchObject({
        name: "AiVideoSubmissionError",
        outcome,
        httpStatus: status,
      });
    },
  );

  it("never resubmits a video the provider may already be working on", async () => {
    // The SDK retries 5XX and connection errors by default. A submission is
    // billed per accepted request, so a retry after a lost response would run
    // and charge for a second video.
    for (const outcome of [
      vi.fn().mockResolvedValue(errorResponse(503)),
      vi.fn().mockRejectedValue(new TypeError("connection reset")),
    ]) {
      vi.stubGlobal("fetch", outcome);
      await expect(createVideoJob(SUBMISSION)).rejects.toMatchObject({
        outcome: "unknown",
      });
      expect(outcome).toHaveBeenCalledOnce();
    }
  });

  it("classifies transport and accepted-but-unparseable outcomes as unknown", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(accepted({ status: "pending", polling_url: "/x" }))
      .mockResolvedValueOnce(
        accepted({ id: "v", polling_url: "/x", status: "who-knows" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    // Either the provider took the request or it did not, and neither reply
    // says; refunding one it accepted would leak a video the user paid for.
    await expect(createVideoJob(SUBMISSION)).rejects.toMatchObject({
      outcome: "unknown",
    });
    await expect(createVideoJob(SUBMISSION)).rejects.toMatchObject({
      execution: "unknown",
    });
  });

  it("classifies a timed-out video submission as unknown", async () => {
    vi.stubEnv("OPENROUTER_REQUEST_TIMEOUT_MS", "5");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (request: Request) =>
          new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            );
          }),
      ),
    );

    await expect(createVideoJob(SUBMISSION)).rejects.toMatchObject({
      name: "AiVideoSubmissionError",
      outcome: "unknown",
    });
  });

  it("preserves the HTTP status when polling a job that is gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 404, message: "gone" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(getVideoJob("missing-video")).rejects.toMatchObject({
      name: "AiProviderError",
      httpStatus: 404,
    });
  });

  it("reads a polled job, its urls and its failure message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        accepted(
          {
            id: "video-1",
            polling_url: "https://openrouter.ai/api/v1/videos/video-1",
            status: "completed",
            unsigned_urls: [
              "https://openrouter.ai/api/v1/videos/video-1/content?index=0",
            ],
          },
          200,
        ),
      ),
    );

    await expect(getVideoJob("video-1")).resolves.toEqual({
      id: "video-1",
      status: "completed",
      unsignedUrls: [
        "https://openrouter.ai/api/v1/videos/video-1/content?index=0",
      ],
      error: null,
    });
  });

  it("reads the capabilities the provider publishes per model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        accepted(
          {
            data: [
              {
                id: "minimax/hailuo-3",
                canonical_slug: "minimax/hailuo-03",
                created: 1,
                name: "MiniMax: H3",
                supported_resolutions: ["2K"],
                supported_durations: [5, 6],
                supported_aspect_ratios: ["16:9"],
                supported_frame_images: ["first_frame"],
                supported_sizes: null,
                generate_audio: true,
                seed: false,
                allowed_passthrough_parameters: [],
              },
            ],
          },
          200,
        ),
      ),
    );

    const models = await listVideoModels();
    expect(models[0]).toMatchObject({
      id: "minimax/hailuo-3",
      supportedResolutions: ["2K"],
      supportedDurations: [5, 6],
      seed: false,
    });
  });
});
