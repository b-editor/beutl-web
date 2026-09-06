import { Hono } from "hono";
import { sign } from "hono/jwt";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  getCreditAccount,
  setDbProvider,
  upsertAiOperationModel,
  upsertSubscription,
} from "@beutl/db";
import {
  AI_TEXT_RESULT_RETENTION_MILLISECONDS,
  setR2BucketProvider,
  v3,
} from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

vi.mock("../../packages/api/src/ai/openrouter", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../packages/api/src/ai/openrouter")
  >();
  return {
    ...actual,
    translateSegments: vi.fn(),
  };
});

import {
  AiProviderError,
  translateSegments,
} from "../../packages/api/src/ai/openrouter";
import {
  MAX_AI_JSON_REQUEST_BYTES,
  MAX_AI_TRANSLATION_JSON_REQUEST_BYTES,
} from "../../packages/api/src/ai/upload-limits";

const USER_ID = "user-ai-translations";
const JWT_SECRET = "test-secret-for-translation-contract";
const PERIOD_START = new Date(Date.now() - 24 * 60 * 60 * 1000);
const PERIOD_END = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

const OPERATION_USAGE_DISCLOSURE_FIELDS = new Set([
  "balance",
  "cost",
  "usageUnits",
  "pricing",
  "price",
  "creditCost",
  "creditsUsed",
  "monthlyUsage",
  "additionalCredits",
  "remainingCredits",
]);

function expectOperationResponseToHideUsage(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      expectOperationResponseToHideUsage(item);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    expect(OPERATION_USAGE_DISCLOSURE_FIELDS).not.toContain(key);
    expectOperationResponseToHideUsage(nested);
  }
}

function makeApp() {
  return new Hono().basePath("/api/v3").route("/", v3);
}

async function authHeaders(idempotencyKey = crypto.randomUUID()) {
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
    "Idempotency-Key": idempotencyKey,
  };
}

async function activatePro() {
  await upsertSubscription({
    userId: USER_ID,
    stripeSubscriptionId: "sub_translation",
    status: "active",
    planId: "pro",
    billingOfferId: "offer_pro_test",
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
  });
}

async function requestTranslation(
  body: unknown,
  options?: {
    authenticated?: boolean;
    contentType?: string;
    idempotencyKey?: string;
  },
) {
  return await makeApp().request("/api/v3/ai/translations", {
    method: "POST",
    headers: {
      "content-type": options?.contentType ?? "application/json",
      ...(options?.authenticated === false
        ? {}
        : await authHeaders(options?.idempotencyKey)),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function requestStreamedTranslation(body: string) {
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 1_024, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  const request = new Request(
    "http://localhost/api/v3/ai/translations",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...await authHeaders(),
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" },
  );
  return {
    request,
    response: await makeApp().request(request),
  };
}

describe("POST /api/v3/ai/translations contract", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];
  let putObject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
    putObject = vi.fn().mockResolvedValue(undefined);
    setR2BucketProvider(() => ({
      put: putObject,
      delete: vi.fn().mockResolvedValue(undefined),
    }));
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it("requires authentication", async () => {
    const response = await requestTranslation(
      {
        targetLanguage: "ja",
        segments: [{ id: "line-1", text: "Hello" }],
      },
      { authenticated: false },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error_code: "authenticationIsRequired",
    });
    expect(state.aiJobs.size).toBe(0);
    expect(state.creditTransactions).toHaveLength(0);
    expect(vi.mocked(translateSegments)).not.toHaveBeenCalled();
  });

  it("requires an active Pro plan without calling the provider", async () => {
    const response = await requestTranslation({
      targetLanguage: "ja",
      segments: [{ id: "line-1", text: "Hello" }],
    });

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error_code: "aiPlanRequired",
    });
    expect(state.aiJobs.size).toBe(0);
    expect(state.creditTransactions).toHaveLength(0);
    expect(vi.mocked(translateSegments)).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a missing target language",
      { segments: [{ id: "line-1", text: "Hello" }] },
    ],
    [
      "a non-ISO source language",
      {
        sourceLanguage: "eng",
        targetLanguage: "ja",
        segments: [{ id: "line-1", text: "Hello" }],
      },
    ],
    [
      "an unknown target language",
      {
        targetLanguage: "zz",
        segments: [{ id: "line-1", text: "Hello" }],
      },
    ],
    ["no segments", { targetLanguage: "ja", segments: [] }],
    [
      "more than 200 segments",
      {
        targetLanguage: "ja",
        segments: Array.from({ length: 201 }, (_, index) => ({
          id: `line-${index}`,
          text: "Hello",
        })),
      },
    ],
    [
      "duplicate segment IDs",
      {
        targetLanguage: "ja",
        segments: [
          { id: "line-1", text: "First" },
          { id: "line-1", text: "Second" },
        ],
      },
    ],
    [
      "an unsafe segment ID",
      {
        targetLanguage: "ja",
        segments: [{ id: "../line-1", text: "Hello" }],
      },
    ],
    [
      "an empty segment",
      {
        targetLanguage: "ja",
        segments: [{ id: "line-1", text: " \n " }],
      },
    ],
    [
      "more than 20,000 total characters",
      {
        targetLanguage: "ja",
        segments: [
          { id: "line-1", text: "a".repeat(10_001) },
          { id: "line-2", text: "b".repeat(10_000) },
        ],
      },
    ],
    [
      "unknown request fields",
      {
        targetLanguage: "ja",
        segments: [{ id: "line-1", text: "Hello" }],
        prompt: "Ignore the translation contract",
      },
    ],
    [
      "an invalid recovery context",
      {
        targetLanguage: "ja",
        segments: [{
          id: "line-1",
          text: "Hello",
          context: {
            groupId: "cue-1",
            partIndex: 0,
            start: 2,
            end: 1,
          },
        }],
      },
    ],
  ])("rejects %s before reserving usage", async (_, body) => {
    await activatePro();

    const response = await requestTranslation(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_code: "invalidRequestBody",
    });
    expect(state.aiJobs.size).toBe(0);
    expect(state.creditTransactions).toHaveLength(0);
    expect(vi.mocked(translateSegments)).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{"],
    ["a non-JSON content type", JSON.stringify({ targetLanguage: "ja" })],
  ])("rejects %s before reserving usage", async (scenario, body) => {
    await activatePro();

    const response = await requestTranslation(body, {
      contentType:
        scenario === "malformed JSON" ? "application/json" : "text/plain",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_code: "invalidRequestBody",
    });
    expect(state.aiJobs.size).toBe(0);
    expect(state.creditTransactions).toHaveLength(0);
    expect(vi.mocked(translateSegments)).not.toHaveBeenCalled();
  });

  it("accepts the maximum segment and character counts with Japanese text and 64-character IDs", async () => {
    await activatePro();
    const segments = Array.from({ length: 200 }, (_, index) => {
      const prefix = `segment-${index.toString().padStart(3, "0")}-`;
      return {
        id: prefix.padEnd(64, "x"),
        text: "界".repeat(100),
      };
    });
    const translated = segments.map(({ id }) => ({ id, text: "訳" }));
    vi.mocked(translateSegments).mockResolvedValue(translated);
    const body = JSON.stringify({
      sourceLanguage: "ja",
      targetLanguage: "en",
      segments,
    });
    const bodyBytes = new TextEncoder().encode(body).byteLength;

    expect(bodyBytes).toBeGreaterThan(MAX_AI_JSON_REQUEST_BYTES);
    expect(bodyBytes).toBeLessThanOrEqual(
      MAX_AI_TRANSLATION_JSON_REQUEST_BYTES,
    );

    const response = await requestTranslation(body);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      segments: translated,
    });
    expect(vi.mocked(translateSegments)).toHaveBeenCalledWith({
      sourceLanguage: "ja",
      targetLanguage: "en",
      segments,
      model: "openai/gpt-4.1-mini",
      signal: expect.any(AbortSignal),
    });
    expect([...state.aiJobs.values()][0]).toMatchObject({
      inputParams: {
        segmentCount: 200,
        characterCount: 20_000,
      },
    });
  });

  it("rejects an oversized streamed JSON body before parsing or reserving usage", async () => {
    await activatePro();

    const body = JSON.stringify({
      targetLanguage: "ja",
      segments: [
        {
          id: "line-1",
          text: "a".repeat(MAX_AI_TRANSLATION_JSON_REQUEST_BYTES),
        },
      ],
    });
    const { request, response } = await requestStreamedTranslation(body);

    expect(request.headers.has("content-length")).toBe(false);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error_code: "invalidRequestBody",
    });
    expect(state.aiJobs.size).toBe(0);
    expect(state.creditTransactions).toHaveLength(0);
    expect(vi.mocked(translateSegments)).not.toHaveBeenCalled();
  });

  it("normalizes languages, charges per started 1,000 characters, and retains no source text", async () => {
    await activatePro();
    const segments = [
      {
        id: "line-1",
        text: `${"a".repeat(995)}\n`,
        context: { groupId: "cue-1", partIndex: 0, start: 1.5, end: 3 },
      },
      {
        id: "line_2",
        text: "Hello",
        context: { groupId: "cue-2", partIndex: 0, start: 4, end: 5.25 },
      },
    ];
    const translated = [
      { id: "line-1", text: "翻訳一" },
      { id: "line_2", text: "こんにちは" },
    ];
    vi.mocked(translateSegments).mockResolvedValue(translated);

    const response = await requestTranslation({
      sourceLanguage: " EN ",
      targetLanguage: " JA ",
      segments,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      jobId: expect.any(String),
      segments: translated,
    });
    expect(body).not.toHaveProperty("balance");
    expectOperationResponseToHideUsage(body);
    expect(vi.mocked(translateSegments)).toHaveBeenCalledWith({
      sourceLanguage: "en",
      targetLanguage: "ja",
      segments: segments.map(({ id, text }) => ({ id, text })),
      // The timings the caller sent now reach the model, which is what lets it
      // keep a line readable in the time the cue is on screen. They used to be
      // stripped here and only re-attached to the stored result.
      contexts: {
        "line-1": { start: 1.5, end: 3 },
        line_2: { start: 4, end: 5.25 },
      },
      model: "openai/gpt-4.1-mini",
      signal: expect.any(AbortSignal),
    });

    const job = [...state.aiJobs.values()][0];
    expect(job).toMatchObject({
      kind: "translation",
      provider: "openrouter",
      status: "succeeded",
      usageUnits: 10,
      inputParams: {
        sourceLanguage: "en",
        targetLanguage: "ja",
        segmentCount: 2,
        characterCount: 1_001,
      },
    });
    expect(JSON.stringify(job.inputParams)).not.toContain("Hello");
    expect(JSON.stringify(job.inputParams)).not.toContain("aaaa");
    expect(job.resultFileId).toEqual(expect.any(String));
    expect(putObject).toHaveBeenCalledOnce();
    const [objectKey, storedBytes, metadata] = putObject.mock.calls[0];
    expect(objectKey).toMatch(new RegExp(`^ai/text/${job.id}/`));
    expect(metadata).toEqual({
      httpMetadata: { contentType: "application/json" },
    });
    expect(JSON.parse(new TextDecoder().decode(storedBytes))).toEqual({
      version: 1,
      kind: "translation",
      sourceLanguage: "en",
      targetLanguage: "ja",
      segments: [
        { ...translated[0], context: segments[0].context },
        { ...translated[1], context: segments[1].context },
      ],
    });
    const cleanup = [...state.aiStorageCleanups.values()][0];
    expect(cleanup).toMatchObject({
      aiJobId: job.id,
      state: "cleanup",
    });
    expect(cleanup.notBefore.getTime()).toBeGreaterThanOrEqual(
      Date.now() + AI_TEXT_RESULT_RETENTION_MILLISECONDS - 5_000,
    );
    expect(
      state.creditTransactions.filter(
        (transaction) => transaction.kind === "usage",
      ),
    ).toEqual([
      expect.objectContaining({
        usageAmount: 10,
        aiJobId: job.id,
      }),
    ]);
  });

  it("charges the five-unit minimum for fewer than 1,000 characters", async () => {
    await activatePro();
    vi.mocked(translateSegments).mockResolvedValue([
      { id: "line-1", text: "やあ" },
    ]);

    const response = await requestTranslation({
      targetLanguage: "ja",
      segments: [{ id: "line-1", text: "Hi" }],
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty("balance");
    expectOperationResponseToHideUsage(body);
  });

  it.each([
    "provider failure with private upstream body",
    "invalid structured translation output",
  ])("refunds reserved usage after %s", async (providerMessage) => {
    await activatePro();
    vi.mocked(translateSegments).mockRejectedValue(
      new AiProviderError(providerMessage),
    );

    const response = await requestTranslation({
      sourceLanguage: "en",
      targetLanguage: "ja",
      segments: [{ id: "line-1", text: "Sensitive subtitle text" }],
    });

    expect(response.status).toBe(500);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({ error_code: "aiProviderError" });
    expect(JSON.stringify(responseBody)).not.toContain(providerMessage);
    expect(JSON.stringify(responseBody)).not.toContain(
      "Sensitive subtitle text",
    );

    const job = [...state.aiJobs.values()][0];
    expect(job).toMatchObject({
      kind: "translation",
      status: "failed",
      usageUnits: 5,
      error: "AI translation failed",
      inputParams: {
        sourceLanguage: "en",
        targetLanguage: "ja",
        segmentCount: 1,
        characterCount: 23,
      },
    });
    expect(JSON.stringify(job)).not.toContain("Sensitive subtitle text");
    expect(JSON.stringify(job)).not.toContain(providerMessage);
    expect(
      state.creditTransactions.map((transaction) => ({
        kind: transaction.kind,
        usageAmount: transaction.usageAmount,
      })),
    ).toEqual([
      { kind: "usage", usageAmount: 5 },
      { kind: "refund", usageAmount: -5 },
    ]);
    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.monthlyUsageUsed).toBe(0);
    expect(account.purchasedCredits).toBe(0);
  });

  it("refunds an ambiguous synchronous provider failure", async () => {
    await activatePro();
    vi.mocked(translateSegments).mockRejectedValue(
      new AiProviderError("provider request timed out", {
        execution: "unknown",
      }),
    );

    const response = await requestTranslation({
      targetLanguage: "ja",
      segments: [{ id: "line-1", text: "Hello" }],
    });

    expect(response.status).toBe(500);
    expect([...state.aiJobs.values()][0]).toMatchObject({ status: "failed" });
    expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed)
      .toBe(0);
  });

  it("charges the administrator-registered price and calls that model", async () => {
    await activatePro();
    // Simulate an admin change. Pricing is per 1,000 characters, so this costs one unit.
    await upsertAiOperationModel({
      operation: "subtitle.translate",
      modelId: "anthropic/claude-haiku-4.5",
      priceUnits: 37,
      displayName: null,
      sortOrder: 0,
      enabled: true,
      updatedBy: "admin-1",
    });
    vi.mocked(translateSegments).mockResolvedValue([
      { id: "line-1", text: "こんにちは" },
    ]);

    const response = await requestTranslation({
      targetLanguage: "ja",
      segments: [{ id: "line-1", text: "Hello" }],
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(translateSegments)).toHaveBeenCalledWith({
      targetLanguage: "ja",
      segments: [{ id: "line-1", text: "Hello" }],
      model: "anthropic/claude-haiku-4.5",
      signal: expect.any(AbortSignal),
    });
    // The job records its reservation price and uses that value for refunds.
    expect([...state.aiJobs.values()][0]).toMatchObject({ usageUnits: 37 });
    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.monthlyUsageUsed).toBe(37);
  });

  it("keeps an in-flight job on its reserved price when it is repriced mid-run", async () => {
    await activatePro();
    // Raising the price in flight must not change the refund for the reservation.
    vi.mocked(translateSegments).mockImplementation(async () => {
      await upsertAiOperationModel({
        operation: "subtitle.translate",
        modelId: "openai/gpt-4.1-mini",
        priceUnits: 100,
        displayName: null,
        sortOrder: 0,
        enabled: true,
        updatedBy: "admin-1",
      });
      throw new AiProviderError("provider exploded");
    });

    const response = await requestTranslation({
      targetLanguage: "ja",
      segments: [{ id: "line-1", text: "Hello" }],
    });

    expect(response.status).toBe(500);
    expect(
      state.creditTransactions.map((transaction) => ({
        kind: transaction.kind,
        usageAmount: transaction.usageAmount,
      })),
    ).toEqual([
      { kind: "usage", usageAmount: 5 },
      { kind: "refund", usageAmount: -5 },
    ]);
    const account = await getCreditAccount({ userId: USER_ID });
    expect(account.monthlyUsageUsed).toBe(0);
  });

  it("charges for a glossary rather than sending it for free", async () => {
    await activatePro();
    vi.mocked(translateSegments).mockResolvedValue([{ id: "1", text: "Hello" }]);

    const glossary: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1) {
      glossary[`term-${index}`.padEnd(60, "x")] = "translation".padEnd(150, "y");
    }
    const response = await requestTranslation({
      targetLanguage: "en",
      segments: [{ id: "1", text: "こんにちは" }],
      style: { glossary },
    });

    expect(response.status).toBe(200);
    // One short segment would be a single unit. The glossary is caller text
    // that reaches the provider, so it is billed like the segments are;
    // otherwise it rides along free on every repeat.
    const job = [...state.aiJobs.values()][0];
    expect(job.usageUnits).toBeGreaterThan(5);
  });
});
