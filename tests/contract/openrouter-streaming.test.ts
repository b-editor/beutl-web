import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiProviderError,
  generateImage,
  translateSegments,
  type PartialImage,
} from "../../packages/api/src/ai/openrouter";

// A streamed reply as OpenRouter sends one: one `data:` line per event, each
// terminated by a blank line.
function eventStream(events: unknown[], { done = true } = {}): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(done ? `${body}data: [DONE]\n\n` : body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function chatChunk(content: string): unknown {
  return {
    id: "gen-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "openai/gpt-4.1-mini",
    choices: [{ index: 0, finish_reason: null, delta: { content } }],
  };
}

// The reply the model builds up, cut where a provider would cut it.
function translationChunks(
  segments: Array<{ id: string; text: string }>,
): unknown[] {
  const reply = JSON.stringify({ segments });
  const pieces: string[] = [];
  for (let index = 0; index < reply.length; index += 17) {
    pieces.push(reply.slice(index, index + 17));
  }
  return pieces.map(chatChunk);
}

async function sentBody(fetchMock: ReturnType<typeof vi.fn>): Promise<
  Record<string, unknown>
> {
  const request = fetchMock.mock.calls[0]?.[0] as Request;
  return (await request.json()) as Record<string, unknown>;
}

describe("streaming a translation", () => {
  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const segments = [
    { id: "line-1", text: "Hello" },
    { id: "line-2", text: "World" },
  ];

  it("hands over each subtitle as it arrives and still returns the whole set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      eventStream(
        translationChunks([
          { id: "line-1", text: "こんにちは" },
          { id: "line-2", text: "世界" },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const seen: Array<{ id: string; text: string }> = [];

    const translated = await translateSegments({
      targetLanguage: "ja",
      segments,
      model: "openai/gpt-4.1-mini",
      onSegment: (segment) => seen.push(segment),
    });

    expect(seen).toEqual([
      { id: "line-1", text: "こんにちは" },
      { id: "line-2", text: "世界" },
    ]);
    // The result is the reply as a whole, in the order it was asked for.
    expect(translated).toEqual([
      { id: "line-1", text: "こんにちは" },
      { id: "line-2", text: "世界" },
    ]);
    expect((await sentBody(fetchMock)).stream).toBe(true);
  });

  it("asks for no stream when nobody is watching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "gen-1",
          object: "chat.completion",
          created: 1,
          model: "openai/gpt-4.1-mini",
          system_fingerprint: null,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  segments: [
                    { id: "line-1", text: "こんにちは" },
                    { id: "line-2", text: "世界" },
                  ],
                }),
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await translateSegments({
      targetLanguage: "ja",
      segments,
      model: "openai/gpt-4.1-mini",
    });

    expect((await sentBody(fetchMock)).stream).toBe(false);
  });

  it("refuses a stream that stops before every subtitle has arrived", async () => {
    // Shown early, judged whole: a reply missing a subtitle is refused exactly
    // as it would be without streaming, whatever was shown on the way.
    const fetchMock = vi.fn().mockResolvedValue(
      eventStream(translationChunks([{ id: "line-1", text: "こんにちは" }])),
    );
    vi.stubGlobal("fetch", fetchMock);
    const seen: Array<{ id: string }> = [];

    await expect(
      translateSegments({
        targetLanguage: "ja",
        segments,
        model: "openai/gpt-4.1-mini",
        onSegment: (segment) => seen.push(segment),
      }),
    ).rejects.toBeInstanceOf(AiProviderError);
    expect(seen.map((segment) => segment.id)).toEqual(["line-1"]);
  });

  it("shows nothing that was not asked for", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      eventStream(
        translationChunks([
          { id: "line-1", text: "こんにちは" },
          { id: "made-up", text: "余計な行" },
          { id: "line-2", text: "世界" },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const seen: Array<{ id: string }> = [];

    await expect(
      translateSegments({
        targetLanguage: "ja",
        segments,
        model: "openai/gpt-4.1-mini",
        onSegment: (segment) => seen.push(segment),
      }),
    ).rejects.toBeInstanceOf(AiProviderError);
    expect(seen.map((segment) => segment.id)).toEqual(["line-1", "line-2"]);
  });

  it("treats an error carried by the stream as a failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      eventStream([
        chatChunk('{"segments":['),
        {
          id: "gen-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "openai/gpt-4.1-mini",
          choices: [],
          error: { code: 502, message: "upstream is unavailable" },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      translateSegments({
        targetLanguage: "ja",
        segments,
        model: "openai/gpt-4.1-mini",
        onSegment: () => undefined,
      }),
    ).rejects.toBeInstanceOf(AiProviderError);
  });
});

describe("streaming an image", () => {
  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hands over each rough version and returns the finished picture", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      eventStream([
        { type: "image_generation.partial_image", b64_json: "AAECAw==", partial_image_index: 0 },
        { type: "image_generation.partial_image", b64_json: "BAUGBw==", partial_image_index: 1 },
        {
          type: "image_generation.completed",
          b64_json: "CAkKCw==",
          created: 1,
          media_type: "image/png",
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const partials: PartialImage[] = [];

    const generated = await generateImage({
      prompt: "a lighthouse",
      aspectRatio: "16:9",
      model: "openai/gpt-image-1",
      onPartialImage: (partial) => partials.push(partial),
    });

    expect(partials).toEqual([
      { index: 0, b64Json: "AAECAw==" },
      { index: 1, b64Json: "BAUGBw==" },
    ]);
    expect(generated).toEqual({ b64Json: "CAkKCw==", mediaType: "image/png" });
    expect((await sentBody(fetchMock)).stream).toBe(true);
  });

  it("takes the one answer a provider that cannot stream gives", async () => {
    // The flag is documented as ignored by providers without native streaming,
    // so the buffered reply has to be read as the picture it is.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          created: 1,
          data: [{ b64_json: "AQID", media_type: "image/png" }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const partials: PartialImage[] = [];

    await expect(
      generateImage({
        prompt: "a lighthouse",
        aspectRatio: "16:9",
        model: "google/imagen",
        onPartialImage: (partial) => partials.push(partial),
      }),
    ).resolves.toEqual({ b64Json: "AQID", mediaType: "image/png" });
    expect(partials).toEqual([]);
  });

  it("refuses a stream that shows a picture but never finishes one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      eventStream([
        { type: "image_generation.partial_image", b64_json: "AAECAw==", partial_image_index: 0 },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateImage({
        prompt: "a lighthouse",
        aspectRatio: "16:9",
        model: "openai/gpt-image-1",
        onPartialImage: () => undefined,
      }),
    ).rejects.toBeInstanceOf(AiProviderError);
  });

  it("treats an error carried by the stream as a failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      eventStream([
        { type: "error", error: { message: "content policy", code: "moderation" } },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateImage({
        prompt: "a lighthouse",
        aspectRatio: "16:9",
        model: "openai/gpt-image-1",
        onPartialImage: () => undefined,
      }),
    ).rejects.toBeInstanceOf(AiProviderError);
  });
});
