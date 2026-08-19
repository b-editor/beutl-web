import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { setDbProvider, upsertSubscription } from "@beutl/db";
import { setR2BucketProvider, v3 } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

vi.mock("../../packages/api/src/ai/openrouter", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../packages/api/src/ai/openrouter")
  >();
  return { ...actual, translateSegments: vi.fn(), generateImage: vi.fn() };
});
vi.mock(
  "../../packages/api/src/ai/image-model-capabilities",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../../packages/api/src/ai/image-model-capabilities")
    >();
    return { ...actual, loadAiImageModelCapabilities: vi.fn(async () => new Map()) };
  },
);

import {
  AiProviderError,
  generateImage,
  translateSegments,
} from "../../packages/api/src/ai/openrouter";

const USER_ID = "user-ai-streaming";
const JWT_SECRET = "test-secret-for-streaming-contract";
const PERIOD_START = new Date(Date.now() - 24 * 60 * 60 * 1000);
const PERIOD_END = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type SseEvent = { event: string; data: unknown };

// Reads a whole event stream. Every AI stream ends, because every one of them
// ends in a result or an error.
async function readEvents(response: Response): Promise<SseEvent[]> {
  const text = await response.text();
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    const name = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (name && data) events.push({ event: name, data: JSON.parse(data) });
  }
  return events;
}

function makeApp() {
  return new Hono().basePath("/api/v3").route("/", v3);
}

async function authHeaders() {
  const token = await sign(
    {
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier":
        USER_ID,
      exp: Math.floor(Date.now() / 1_000) + 300,
    },
    JWT_SECRET,
    "HS256",
  );
  return {
    Authorization: `Bearer ${token}`,
    "Idempotency-Key": crypto.randomUUID(),
  };
}

async function activatePro() {
  await upsertSubscription({
    userId: USER_ID,
    stripeSubscriptionId: "sub_streaming",
    status: "active",
    planId: "pro",
    billingOfferId: "offer_pro_test",
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
  });
}

async function post(path: string, body: unknown, accept?: string) {
  return await makeApp().request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accept ? { accept } : {}),
      ...(await authHeaders()),
    },
    body: JSON.stringify(body),
  });
}

const TRANSLATION_BODY = {
  targetLanguage: "ja",
  segments: [
    { id: "line-1", text: "Hello" },
    { id: "line-2", text: "World" },
  ],
};

describe("asking an AI endpoint to answer as it goes", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];

  beforeEach(() => {
    vi.clearAllMocks();
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
    setR2BucketProvider(() => ({
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    }));
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it("sends each subtitle as it is translated and then the whole result", async () => {
    await activatePro();
    vi.mocked(translateSegments).mockImplementation(async ({ segments, onSegment }) => {
      const translated = segments.map((segment, index) => ({
        id: segment.id,
        text: `訳${index + 1}`,
      }));
      for (const segment of translated) onSegment?.(segment);
      return translated;
    });

    const response = await post(
      "/api/v3/ai/translations",
      TRANSLATION_BODY,
      "text/event-stream",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = await readEvents(response);
    expect(events.map((event) => event.event)).toEqual([
      "segment",
      "segment",
      "result",
    ]);
    expect(events[0].data).toEqual({ id: "line-1", text: "訳1" });
    // The closing event is the same answer the caller would have waited for.
    expect(events[2].data).toMatchObject({
      segments: [
        { id: "line-1", text: "訳1" },
        { id: "line-2", text: "訳2" },
      ],
    });
    expect(state.aiJobs.size).toBe(1);
  });

  it("answers in one piece when the caller did not ask otherwise", async () => {
    await activatePro();
    vi.mocked(translateSegments).mockImplementation(async ({ segments, onSegment }) => {
      expect(onSegment).toBeUndefined();
      return segments.map((segment) => ({ id: segment.id, text: "訳" }));
    });

    const response = await post("/api/v3/ai/translations", TRANSLATION_BODY);

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      segments: [
        { id: "line-1", text: "訳" },
        { id: "line-2", text: "訳" },
      ],
    });
  });

  it("refuses a request it cannot serve with a status code, not a stream", async () => {
    // A stream cannot take back its status, so everything that could refuse the
    // request has to be settled before the first byte goes out.
    const response = await post(
      "/api/v3/ai/translations",
      TRANSLATION_BODY,
      "text/event-stream",
    );

    expect(response.status).toBe(402);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error_code: "aiPlanRequired" });
    expect(vi.mocked(translateSegments)).not.toHaveBeenCalled();
  });

  it("ends a failed run with an error event and gives the usage back", async () => {
    await activatePro();
    vi.mocked(translateSegments).mockImplementation(async ({ onSegment }) => {
      onSegment?.({ id: "line-1", text: "訳1" });
      throw new AiProviderError("the provider gave up");
    });

    const response = await post(
      "/api/v3/ai/translations",
      TRANSLATION_BODY,
      "text/event-stream",
    );
    const events = await readEvents(response);

    expect(events.map((event) => event.event)).toEqual(["segment", "error"]);
    expect(events[1].data).toMatchObject({ error_code: "aiProviderError" });
    // Shown early, but nothing was produced: the reservation goes back exactly
    // as it does without streaming.
    expect(
      state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(1);
  });

  it("sends each rough picture and then the finished one", async () => {
    await activatePro();
    vi.mocked(generateImage).mockImplementation(async ({ onPartialImage }) => {
      onPartialImage?.({ index: 0, b64Json: "AAEC" });
      onPartialImage?.({ index: 1, b64Json: "AwQF" });
      return {
        b64Json: PNG_BYTES.toString("base64"),
        mediaType: "image/png",
      };
    });

    const response = await post(
      "/api/v3/ai/images",
      { prompt: "a lighthouse", aspectRatio: "16:9" },
      "text/event-stream",
    );
    const events = await readEvents(response);

    expect(events.map((event) => event.event)).toEqual([
      "partial",
      "partial",
      "result",
    ]);
    expect(events[0].data).toEqual({ index: 0, image: "AAEC" });
    expect(events[2].data).toMatchObject({ contentType: "image/png" });
    // A rough version is a preview, so nothing about it may reveal what the
    // operation costs.
    expect(JSON.stringify(events)).not.toContain("usageUnits");
  });

  it("gives the usage back when a picture never finishes", async () => {
    await activatePro();
    vi.mocked(generateImage).mockImplementation(async ({ onPartialImage }) => {
      onPartialImage?.({ index: 0, b64Json: "AAEC" });
      throw new AiProviderError("the stream ended early");
    });

    const response = await post(
      "/api/v3/ai/images",
      { prompt: "a lighthouse", aspectRatio: "16:9" },
      "text/event-stream",
    );
    const events = await readEvents(response);

    expect(events.map((event) => event.event)).toEqual(["partial", "error"]);
    expect(
      state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(1);
  });
});
