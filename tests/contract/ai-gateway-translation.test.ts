import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { setDbProvider, upsertAiOperationModel, upsertSubscription } from "@beutl/db";
import { setR2BucketProvider, v3 } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";
import { translateGatewaySegments } from "../../packages/api/src/ai/providers/vercel-gateway/translation";
import { translationJsonSchema } from "../../packages/api/src/ai/translation-contract";
import { AiProviderError } from "../../packages/api/src/ai/providers/errors";

const MODEL = "openai/gpt-5.6-luna";
const INPUT = [
  { id: "line-1", text: "Hello" },
  { id: "line-2", text: "World" },
];
const TRANSLATED = [
  { id: "line-1", text: "こんにちは" },
  { id: "line-2", text: "世界" },
];
const USAGE = {
  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

// The real Gateway SDK uses its language-model protocol, not chat completions.
// Mock only the HTTP response so the SDK's request serialization is exercised.
function gatewayResponse(
  text: string,
  streaming: boolean,
  options: { reason?: string; error?: string; omitFinish?: boolean } = {},
): Response {
  const finishReason = { unified: options.reason ?? "stop", raw: options.reason ?? "stop" };
  if (!streaming) {
    return Response.json({
      content: [{ type: "text", text }],
      finishReason,
      usage: USAGE,
      warnings: [],
    });
  }
  const chunks = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "text-1" },
    ...Array.from({ length: Math.ceil(text.length / 11) }, (_, index) => ({
      type: "text-delta",
      id: "text-1",
      delta: text.slice(index * 11, (index + 1) * 11),
    })),
    { type: "text-end", id: "text-1" },
    ...(options.error ? [{ type: "error", error: options.error }] : []),
    ...(options.omitFinish ? [] : [{ type: "finish", finishReason, usage: USAGE }]),
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("Gateway subtitle translation", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_AI_GATEWAY_API_KEY", "test-gateway-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([false, true])("sends the subtitle schema in the SDK response format (streaming=%s)", async (streaming) => {
    const fetchMock = vi.fn(async () => gatewayResponse(JSON.stringify({ segments: TRANSLATED }), streaming));
    vi.stubGlobal("fetch", fetchMock);
    const onSegment = vi.fn();

    await expect(translateGatewaySegments({
      model: MODEL,
      targetLanguage: "ja",
      segments: INPUT,
      ...(streaming ? { onSegment } : {}),
    })).resolves.toEqual(TRANSLATED);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ai-gateway.vercel.sh/v4/ai/language-model");
    expect(new Headers(init.headers).get("ai-language-model-id")).toBe(MODEL);
    expect(new Headers(init.headers).get("ai-language-model-streaming")).toBe(String(streaming));
    const body = JSON.parse(init.body as string);
    expect(body.responseFormat).toEqual({
      type: "json",
      name: "subtitle_translation",
      schema: translationJsonSchema(INPUT),
    });
    expect(body.providerOptions?.gateway?.responseFormat).toBeUndefined();
    if (streaming) {
      expect(onSegment.mock.calls.map(([segment]) => segment)).toEqual(TRANSLATED);
    }
  });

  it("finishes after previews when the provider requires the top-level format to emit strict JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const json = JSON.stringify({ segments: TRANSLATED });
      // Without structured output a valid model reply can be fenced Markdown.
      // The preview reader finds its subtitles but final JSON.parse rejects it.
      return gatewayResponse(body.responseFormat?.type === "json" ? json : `\`\`\`json\n${json}\n\`\`\``, true);
    }));
    const onSegment = vi.fn();

    await expect(translateGatewaySegments({
      model: MODEL,
      targetLanguage: "ja",
      segments: INPUT,
      onSegment,
    })).resolves.toEqual(TRANSLATED);
    expect(onSegment.mock.calls.map(([segment]) => segment)).toEqual(TRANSLATED);
  });

  it("rejects an error event even when all translated JSON has arrived", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => gatewayResponse(
      JSON.stringify({ segments: TRANSLATED }), true, { error: "provider failed at the end" },
    )));
    const onSegment = vi.fn();
    await expect(translateGatewaySegments({
      model: MODEL, targetLanguage: "ja", segments: INPUT, onSegment,
    })).rejects.toBeInstanceOf(AiProviderError);
    expect(onSegment.mock.calls.map(([segment]) => segment)).toEqual(TRANSLATED);
  });

  it.each(["error", "length", "content-filter"])("rejects a %s completion in both response modes", async (reason) => {
    for (const streaming of [false, true]) {
      vi.stubGlobal("fetch", vi.fn(async () => gatewayResponse(
        JSON.stringify({ segments: TRANSLATED }), streaming, { reason },
      )));
      await expect(translateGatewaySegments({
        model: MODEL, targetLanguage: "ja", segments: INPUT,
        ...(streaming ? { onSegment: vi.fn() } : {}),
      })).rejects.toBeInstanceOf(AiProviderError);
    }
  });

  it("rejects a stream cut off after valid JSON but before its finish event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => gatewayResponse(
      JSON.stringify({ segments: TRANSLATED }), true, { omitFinish: true },
    )));
    await expect(translateGatewaySegments({
      model: MODEL, targetLanguage: "ja", segments: INPUT, onSegment: vi.fn(),
    })).rejects.toBeInstanceOf(AiProviderError);
  });

  it("persists the Gateway result and sends a final result event after the previews", async () => {
    const userId = "gateway-translation-user";
    const jwtSecret = "gateway-translation-test";
    vi.stubEnv("JWT_SECRET", jwtSecret);
    const { prisma, state } = createInMemoryPrisma();
    setDbProvider(async () => prisma as never);
    const put = vi.fn().mockResolvedValue(undefined);
    setR2BucketProvider(() => ({ put, delete: vi.fn().mockResolvedValue(undefined) }));
    await upsertSubscription({
      userId,
      stripeSubscriptionId: "sub_gateway_translation",
      status: "active",
      planId: "pro",
      billingOfferId: "offer_pro_test",
      currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    });
    await upsertAiOperationModel({
      operation: "subtitle.translate",
      modelId: MODEL,
      provider: "vercel-gateway",
      priceUnits: 5,
      displayName: null,
      sortOrder: 0,
      enabled: true,
      updatedBy: "admin",
    });
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.responseFormat?.type).toBe("json");
      return gatewayResponse(JSON.stringify({ segments: TRANSLATED }), true);
    }));
    const token = await sign({
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": userId,
      exp: Math.floor(Date.now() / 1000) + 300,
    }, jwtSecret, "HS256");

    const response = await new Hono().basePath("/api/v3").route("/", v3).request(
      "/api/v3/ai/translations",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "text/event-stream",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ model: MODEL, targetLanguage: "ja", segments: INPUT }),
      },
    );

    expect(response.status).toBe(200);
    const events = (await response.text()).split("\n\n").filter(Boolean).map((block) => ({
      event: /^event: (.+)$/m.exec(block)?.[1],
      data: JSON.parse(/^data: (.+)$/m.exec(block)![1]),
    }));
    expect(events.map(({ event }) => event)).toEqual(["segment", "segment", "result"]);
    expect(events[2].data).toMatchObject({ segments: TRANSLATED });
    expect([...state.aiJobs.values()]).toEqual([
      expect.objectContaining({ provider: "vercel-gateway", status: "succeeded" }),
    ]);
    expect(put).toHaveBeenCalledOnce();
    expect(JSON.parse(new TextDecoder().decode(put.mock.calls[0][1]))).toMatchObject({
      kind: "translation",
      segments: TRANSLATED,
    });
    expect(state.creditTransactions.filter(({ kind }) => kind === "refund")).toHaveLength(0);
  });

  it.each([
    { segments: [TRANSLATED[0]] },
    { segments: [TRANSLATED[0], TRANSLATED[0]] },
    { segments: [TRANSLATED[0], { id: "invented", text: "世界" }] },
    { segments: [TRANSLATED[0], { id: "line-2", text: " " }] },
    { segments: TRANSLATED, commentary: "Done" },
  ])("does not accept invalid results after showing previews: %j", async (result) => {
    vi.stubGlobal("fetch", vi.fn(async () => gatewayResponse(JSON.stringify(result), true)));
    const onSegment = vi.fn();

    await expect(translateGatewaySegments({
      model: MODEL,
      targetLanguage: "ja",
      segments: INPUT,
      onSegment,
    })).rejects.toBeInstanceOf(AiProviderError);
    expect(onSegment).toHaveBeenCalledWith(TRANSLATED[0]);
  });
});
