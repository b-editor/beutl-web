import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHmac } from "node:crypto";
import {
  AiProviderError,
  createOpenRouterClient,
  AiVideoSubmissionError,
  InvalidAiProviderOutputError,
  downloadVideoContent,
  editImage,
  generateImage,
  getOpenRouterRequestTimeoutMilliseconds,
  MAX_OPENROUTER_JSON_RESPONSE_BYTES,
  OPENROUTER_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  transcribeAudio,
  verifyOpenRouterWebhookSignature,
} from "../../packages/api/src/ai/openrouter";
import { MAX_AI_GENERATED_VIDEO_BYTES } from "../../packages/api/src/ai/video-validation";

const VALID_MP4_BYTES = Uint8Array.from(
  Buffer.from(
    "AAAAFGZ0eXBpc29tAAAAAW1wNDIAAAAPbWRhdAAAAANliIQAAAFzbW9vdgAAABxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAAFPdHJhawAAACB0a2hkAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAPoAAABJ21kaWEAAAAcbWRoZAAAAAAAAAAAAAAAAAAAA+gAAAPoAAAAFGhkbHIAAAAAAAAAAHZpZGUAAADvbWluZgAAAOdzdGJsAAAAf3N0c2QAAAAAAAAAAQAAAG9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAEAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGWF2Y0MBQgAe/+EABGdCAB4BAAJozgAAABhzdHRzAAAAAAAAAAEAAAABAAAD6AAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAYc3RzegAAAAAAAAAAAAAAAQAAAAcAAAAUc3RjbwAAAAAAAAABAAAAHA==",
    "base64",
  ),
);

function oversizedChunkedResponse(
  maximumBytes: number,
  headers: HeadersInit,
): { response: Response; wasCancelled(): boolean } {
  const chunk = new Uint8Array(1024 * 1024);
  let cancelled = false;
  let emittedBytes = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      emittedBytes += chunk.byteLength;
      controller.enqueue(chunk);
      if (emittedBytes > maximumBytes + chunk.byteLength) {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(stream, { headers }),
    wasCancelled: () => cancelled,
  };
}

// The SDK hands fetch a Request rather than (url, init), so what was sent is
// read off that.
async function sentRequest(
  fetchMock: ReturnType<typeof vi.fn>,
  call = 0,
): Promise<{
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}> {
  const request = fetchMock.mock.calls[call]?.[0] as Request;
  return {
    url: request.url,
    method: request.method,
    authorization: request.headers.get("authorization"),
    contentType: request.headers.get("content-type"),
    body: await request.json(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenRouter client contract", () => {
  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the dedicated image API with the requested aspect ratio", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        created: 1,
        data: [{ b64_json: "AQID", media_type: "image/png" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateImage({
        prompt: "a lighthouse",
        aspectRatio: "2:3",
        model: "openai/gpt-image-1",
      }),
    ).resolves.toEqual({ b64Json: "AQID", mediaType: "image/png" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const sent = await sentRequest(fetchMock);
    expect(sent.url).toBe("https://openrouter.ai/api/v1/images");
    expect(sent.method).toBe("POST");
    expect(sent.authorization).toBe("Bearer test-openrouter-key");
    expect(sent.contentType).toContain("application/json");
    expect(sent.body).toEqual({
      model: "openai/gpt-image-1",
      prompt: "a lighthouse",
      aspect_ratio: "2:3",
      n: 1,
      output_format: "png",
    });
  });

  it("sends a transparent background, a seed and a reference image only when asked", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        created: 1,
        data: [{ b64_json: "AQID", media_type: "image/png" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateImage({
      prompt: "a logo",
      aspectRatio: "16:9",
      background: "transparent",
      seed: 7,
      referenceImages: [
        { bytes: Uint8Array.from([1, 2, 3]).buffer, mimeType: "image/png" },
      ],
      model: "openai/gpt-image-1",
    });

    expect((await sentRequest(fetchMock)).body).toEqual({
      model: "openai/gpt-image-1",
      prompt: "a logo",
      aspect_ratio: "16:9",
      n: 1,
      output_format: "png",
      background: "transparent",
      seed: 7,
      input_references: [
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      ],
    });
  });

  it("omits an automatic background so the provider default is untouched", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        created: 1,
        data: [{ b64_json: "AQID", media_type: "image/png" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateImage({
      prompt: "a lighthouse",
      aspectRatio: "1:1",
      background: "auto",
      model: "openai/gpt-image-1",
    });

    expect((await sentRequest(fetchMock)).body).not.toHaveProperty(
      "background",
    );
  });

  it("aborts a provider request after the configured timeout", async () => {
    vi.stubEnv("OPENROUTER_REQUEST_TIMEOUT_MS", "5");
    const fetchMock = vi.fn().mockImplementation(
      (request: Request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateImage({
        prompt: "a lighthouse",
        aspectRatio: "1:1",
        model: "openai/gpt-image-1",
      }),
    ).rejects.toThrow("timed out");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never repeats a paid request the provider may already be running", async () => {
    // The SDK retries 5XX and connection errors for up to an hour by default.
    // Every call here is billed per accepted request, so a retry after a lost
    // response would run and charge for the work a second time.
    for (const outcome of [
      vi.fn().mockResolvedValue(jsonResponse({ error: "overloaded" }, 503)),
      vi.fn().mockRejectedValue(new TypeError("connection reset")),
    ]) {
      vi.stubGlobal("fetch", outcome);
      await expect(
        generateImage({
          prompt: "a lighthouse",
          aspectRatio: "1:1",
          model: "openai/gpt-image-1",
        }),
      ).rejects.toBeInstanceOf(AiProviderError);
      expect(outcome).toHaveBeenCalledOnce();
    }
  });

  it("resolves the request timeout used by polling leases", () => {
    expect(getOpenRouterRequestTimeoutMilliseconds(undefined)).toBe(120_000);
    expect(getOpenRouterRequestTimeoutMilliseconds("185000")).toBe(185_000);
    expect(() => getOpenRouterRequestTimeoutMilliseconds("invalid"))
      .toThrow("must be a positive integer");
  });

  it("verifies the raw OpenRouter webhook body and enforces timestamp tolerance", async () => {
    const secret = "openrouter-webhook-secret";
    const rawBody = new TextEncoder().encode(
      '{"type":"video.generation.completed","spacing":true}',
    );
    const now = new Date("2026-08-11T12:00:00.000Z");
    const timestamp = Math.floor(now.getTime() / 1_000).toString();
    const signature = createHmac("sha256", secret)
      .update(`${timestamp},`)
      .update(rawBody)
      .digest("hex");
    const signatureHeader = `t=${timestamp},v1=${signature}`;

    await expect(
      verifyOpenRouterWebhookSignature({
        rawBody,
        signatureHeader,
        now,
        secret,
      }),
    ).resolves.toBe(true);
    await expect(
      verifyOpenRouterWebhookSignature({
        rawBody: new TextEncoder().encode(
          '{"type":"video.generation.completed","spacing":false}',
        ),
        signatureHeader,
        now,
        secret,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyOpenRouterWebhookSignature({
        rawBody,
        signatureHeader,
        now: new Date(
          now.getTime() +
            (OPENROUTER_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 1) * 1_000,
        ),
        secret,
      }),
    ).resolves.toBe(false);
  });

  it("stops a chunked provider JSON response before unbounded parsing", async () => {
    const oversized = oversizedChunkedResponse(
      MAX_OPENROUTER_JSON_RESPONSE_BYTES,
      { "content-type": "application/json" },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(oversized.response));

    await expect(
      generateImage({
        prompt: "test",
        aspectRatio: "1:1",
        model: "openai/gpt-image-1",
      }),
    ).rejects.toBeInstanceOf(AiProviderError);
    expect(oversized.wasCancelled()).toBe(true);
  });

  it("rejects an oversized declared provider JSON response before reading it", async () => {
    const response = new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_OPENROUTER_JSON_RESPONSE_BYTES + 1),
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      generateImage({
        prompt: "test",
        aspectRatio: "1:1",
        model: "openai/gpt-image-1",
      }),
    ).rejects.toBeInstanceOf(AiProviderError);
  });

  it("sends image edits as base64 input references", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        created: 1,
        data: [{ b64_json: "BAUG", media_type: "image/png" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await editImage({
      task: "remove_background",
      image: Uint8Array.from([1, 2, 3]).buffer,
      mimeType: "image/png",
      model: "openai/gpt-image-1",
    });

    const sentEdit = await sentRequest(fetchMock);
    expect(sentEdit.url).toBe("https://openrouter.ai/api/v1/images");
    expect(sentEdit.body).toEqual({
      model: "openai/gpt-image-1",
      prompt:
        "Remove the entire background. Preserve the foreground subject exactly and return it on a fully transparent background.",
      input_references: [
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AQID" },
        },
      ],
      n: 1,
      background: "transparent",
      output_format: "png",
    });
  });

  it("requests a 4K-capable model for upscaling", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        created: 1,
        data: [{ b64_json: "AQID", media_type: "image/jpeg" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await editImage({
      task: "upscale",
      image: Uint8Array.from([1]).buffer,
      mimeType: "image/jpeg",
      model: "bytedance-seed/seedream-4.5",
    });

    expect((await sentRequest(fetchMock)).body).toMatchObject({
      model: "bytedance-seed/seedream-4.5",
      resolution: "4K",
      output_format: "png",
    });
  });

  it.each([
    ["restyle", "Restyle this as a watercolor painting"],
    ["remove_object", "Remove the bicycle behind the subject"],
    ["outpaint", "Extend the mountain landscape on both sides"],
  ] as const)(
    "sends %s edits as prompted input references without unsupported fields",
    async (task, prompt) => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          created: 1,
          data: [{ b64_json: "AQID", media_type: "image/png" }],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await editImage({
        task,
        image: Uint8Array.from([1, 2, 3]).buffer,
        mimeType: "image/webp",
        prompt,
        model: "openai/gpt-image-1",
      });

      const sent = await sentRequest(fetchMock);
      expect(sent.url).toBe("https://openrouter.ai/api/v1/images");
      expect(sent.body).toEqual({
        model: "openai/gpt-image-1",
        prompt,
        input_references: [
          {
            type: "image_url",
            image_url: { url: "data:image/webp;base64,AQID" },
          },
        ],
        n: 1,
        output_format: "png",
      });
    },
  );

  it("rejects an advanced image edit without a prompt before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      editImage({
        task: "outpaint",
        image: Uint8Array.from([1]).buffer,
        mimeType: "image/png",
        model: "openai/gpt-image-1",
      }),
    ).rejects.toBeInstanceOf(AiProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Named in the comment on transcribeAudio: when this fails, the SDK has
  // learned to repeat a multipart field and transcription can move onto it.
  it("openRouterMultipartFieldsAreRepeated", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ text: "hello" }));
    vi.stubGlobal("fetch", fetchMock);

    await createOpenRouterClient().stt.createTranscriptionMultipart({
      requestBody: {
        model: "openai/whisper-large-v3-turbo",
        file: new File([Uint8Array.from([1, 2, 3])], "a.wav", {
          type: "audio/wav",
        }),
        responseFormat: "verbose_json",
        timestampGranularities: ["segment", "word"],
      },
    });

    const form = await (fetchMock.mock.calls[0][0] as Request).formData();
    // One comma-joined value rather than two fields. OpenRouter rejects this
    // with 400 `Invalid option: expected one of "word"|"segment"`, which is why
    // transcribeAudio builds the body itself.
    expect(form.getAll("timestamp_granularities[]")).toEqual(["segment,word"]);
  });

  it("requests segment and word timestamps and parses optional metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        language: " ja ",
        segments: [
          { start: 0, end: 1.5, text: " First line " },
          { start: 1.5, end: 3, text: "Second line" },
        ],
        words: [
          { start: 0, end: 0.5, word: " First " },
          { start: 0.5, end: 1, word: "line" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      transcribeAudio({
        audio: Uint8Array.from([1, 2, 3]).buffer,
        durationSeconds: 3,
        filename: "voice.wav",
        mimeType: "audio/wav",
        language: "ja",
        model: "openai/whisper-large-v3-turbo",
      }),
    ).resolves.toEqual({
      segments: [
        { start: 0, end: 1.5, text: "First line" },
        { start: 1.5, end: 3, text: "Second line" },
      ],
      language: "ja",
      words: [
        { start: 0, end: 0.5, word: "First" },
        { start: 0.5, end: 1, word: "line" },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://openrouter.ai/api/v1/audio/transcriptions",
    );
    const body = init.body as FormData;
    expect(body.get("model")).toBe("openai/whisper-large-v3-turbo");
    expect(body.get("response_format")).toBe("verbose_json");
    expect(body.getAll("timestamp_granularities[]")).toEqual([
      "segment",
      "word",
    ]);
    expect(body.get("language")).toBe("ja");
    expect(body.get("file")).toBeInstanceOf(File);
  });

  it("clamps a tiny transcription duration overshoot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          segments: [{ start: 0, end: 3.01, text: "Rounded duration" }],
        }),
      ),
    );

    await expect(
      transcribeAudio({
        audio: Uint8Array.from([1]).buffer,
        durationSeconds: 3,
        filename: "voice.wav",
        mimeType: "audio/wav",
        model: "openai/whisper-large-v3-turbo",
      }),
    ).resolves.toEqual({
      segments: [{ start: 0, end: 3, text: "Rounded duration" }],
    });
  });

  it("rejects transcription timestamps materially beyond the audio duration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          segments: [{ start: 0, end: 3.1, text: "Out of bounds" }],
        }),
      ),
    );

    await expect(
      transcribeAudio({
        audio: Uint8Array.from([1]).buffer,
        durationSeconds: 3,
        filename: "voice.wav",
        mimeType: "audio/wav",
        model: "openai/whisper-large-v3-turbo",
      }),
    ).rejects.toThrow("invalid transcription data");
  });

  it("preserves the segment-only transcription response shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          segments: [{ start: 0, end: 1, text: "Legacy response" }],
        }),
      ),
    );

    await expect(
      transcribeAudio({
        audio: Uint8Array.from([1]).buffer,
        durationSeconds: 1,
        filename: "voice.mp3",
        mimeType: "audio/mpeg",
        model: "openai/whisper-large-v3-turbo",
      }),
    ).resolves.toEqual({
      segments: [{ start: 0, end: 1, text: "Legacy response" }],
    });
  });

  it("downloads generated video content with authentication", async () => {
    // The finished video still comes through the hand-rolled request: the bytes
    // are cross-checked against the declared content type, and the SDK hands
    // back a body stream without it.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(VALID_MP4_BYTES, {
        headers: { "content-type": "video/mp4" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const content = await downloadVideoContent("video-1");

    expect(new Uint8Array(content.bytes)).toEqual(VALID_MP4_BYTES);
    expect(content.mimeType).toBe("video/mp4");
    expect(content.extension).toBe("mp4");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://openrouter.ai/api/v1/videos/video-1/content?index=0",
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: "Bearer test-openrouter-key" },
    });
  });

  it("stops a generated video stream at the byte cap", async () => {
    const oversized = oversizedChunkedResponse(
      MAX_AI_GENERATED_VIDEO_BYTES,
      { "content-type": "video/mp4" },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(oversized.response));

    await expect(downloadVideoContent("video-large")).rejects.toBeInstanceOf(
      InvalidAiProviderOutputError,
    );
    expect(oversized.wasCancelled()).toBe(true);
  });

  it("rejects declared oversized generated video content as invalid provider output", async () => {
    const response = new Response(VALID_MP4_BYTES, {
      headers: {
        "content-type": "video/mp4",
        "content-length": String(MAX_AI_GENERATED_VIDEO_BYTES + 1),
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(downloadVideoContent("video-large-declared"))
      .rejects.toBeInstanceOf(InvalidAiProviderOutputError);
  });

  it("wraps malformed provider responses as provider errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [] })));

    await expect(
      generateImage({
        prompt: "test",
        aspectRatio: "1:1",
        model: "openai/gpt-image-1",
      }),
    ).rejects.toBeInstanceOf(AiProviderError);
  });
});
