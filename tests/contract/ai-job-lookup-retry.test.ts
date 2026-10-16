import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import {
  createAiJob,
  createFile,
  setDbProvider,
  upsertAiOperationModel,
  upsertSubscription,
} from "@beutl/db";
import { aiCapabilityKey, setR2BucketProvider, sha256Hex, v3 } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

// GET /v3/ai/jobs/by-idempotency-key and POST /v3/ai/jobs/:id/retry, on the v3
// app and through the Web Worker and Next.js entry points, with no live provider.
const mocks = vi.hoisted(() => ({
  next: vi.fn(async () => new Response("Next page")),
  db: {} as object,
  context: vi.fn(),
  loadAiImageModelCapabilities: vi.fn(async () => new Map()),
}));
vi.mock("../../apps/web/.open-next/worker.js", () => ({
  default: { fetch: mocks.next },
  DOQueueHandler: class {}, DOShardedTagCache: class {}, BucketCachePurge: class {},
}));
vi.mock("@prisma/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@prisma/client")>(),
  PrismaClient: class { constructor() { return mocks.db; } },
}));
vi.mock("../../packages/api/src/ai/openrouter", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../packages/api/src/ai/openrouter")>(),
  generateImage: vi.fn(),
}));
vi.mock("../../packages/api/src/ai/openrouter-video", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../packages/api/src/ai/openrouter-video")>(),
  createVideoJob: vi.fn(),
}));
// Capabilities and rate cards are live lookups; fixed answers keep these tests offline.
vi.mock("../../packages/api/src/ai/image-model-capabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../packages/api/src/ai/image-model-capabilities")>(),
  loadAiImageModelCapabilities: mocks.loadAiImageModelCapabilities,
}));
vi.mock("../../packages/api/src/ai/video-model-capabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../packages/api/src/ai/video-model-capabilities")>(),
  loadAiVideoModelCapabilities: vi.fn(async () => new Map()),
}));
vi.mock("../../packages/api/src/ai/usage-cost", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../packages/api/src/ai/usage-cost")>(),
  quoteAiUsageReservation: vi.fn(async () => ({
    providerCostUsd: 0.24,
    estimatedProviderCostUsd: 0.2,
    operation: "image.generate",
  })),
}));

import web from "../../apps/web/worker.js";
import { AiProviderError, generateImage } from "../../packages/api/src/ai/openrouter";
import { createVideoJob } from "../../packages/api/src/ai/openrouter-video";

const USER_ID = "ai-retry-user";
const OTHER_USER_ID = "ai-retry-other-user";
const JWT_SECRET = "ai-job-lookup-retry-secret";
const ORIGIN = "https://beutl.beditor.net";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const LOOKUP = "/api/v3/ai/jobs/by-idempotency-key";
const image = { prompt: "a red fox", aspectRatio: "16:9", seed: 7 };
const video = { prompt: "a calm sea", durationSeconds: 4, resolution: "720p" };
const bucket = {
  put: vi.fn(async () => ({})),
  delete: vi.fn(async () => undefined),
};
const env = {
  BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://ai-retry-test" },
  JWT_SECRET, JWT_ISSUER: "", JWT_AUDIENCE: "",
  PUBLIC_ORIGIN: ORIGIN,
  BEUTL_R2_BUCKET: bucket,
};
const context = () => ({
  waitUntil: (_promise: Promise<unknown>) => undefined,
  passThroughOnException() {},
  props: {},
});

let memory: ReturnType<typeof createInMemoryPrisma>;

beforeEach(async () => {
  vi.clearAllMocks();
  memory = createInMemoryPrisma();
  mocks.db = Object.assign(memory.prisma, { $disconnect: vi.fn(async () => undefined) });
  mocks.context.mockImplementation(() => ({ env, ctx: context() }));
  // The Worker binds its own client and bucket per invocation; Next uses these.
  setDbProvider(async () => memory.prisma as never);
  setR2BucketProvider(() => bucket);
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") vi.stubEnv(key, value);
  }
  mocks.loadAiImageModelCapabilities.mockResolvedValue(new Map());
  vi.mocked(generateImage).mockResolvedValue({ b64Json: PNG_BASE64, mediaType: "image/png" });
  vi.mocked(createVideoJob).mockResolvedValue({ id: "provider-video-retry", status: "pending" } as never);
  await upsertSubscription({
    userId: USER_ID,
    stripeSubscriptionId: "sub_ai_retry",
    status: "active",
    planId: "pro",
    billingOfferId: "offer_pro_test",
    currentPeriodStart: new Date(Date.now() - 86_400_000),
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
  });
  for (const [operation, modelId] of [["image.generate", "dear/model"], ["video.generate", "dear/video"]]) {
    await upsertAiOperationModel({
      operation, modelId, displayName: null, sortOrder: 0, enabled: true, updatedBy: "admin",
    });
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const makeApp = () => new Hono().basePath("/api/v3").route("/", v3);

async function authorization(userId = USER_ID) {
  return `Bearer ${await sign({
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier": userId,
    exp: Math.floor(Date.now() / 1000) + 300,
  }, JWT_SECRET, "HS256")}`;
}

async function headersOf({ userId = USER_ID, key, accept, anonymous }: {
  userId?: string;
  key?: string;
  accept?: string;
  anonymous?: boolean;
} = {}) {
  return {
    ...(anonymous ? {} : { authorization: await authorization(userId) }),
    ...(key === undefined ? {} : { "Idempotency-Key": key }),
    ...(accept ? { accept } : {}),
  };
}

async function call(method: string, path: string, options?: Parameters<typeof headersOf>[0]) {
  return await makeApp().request(path, { method, headers: await headersOf(options) });
}

const retry = (jobId: string, options?: Parameters<typeof headersOf>[0]) =>
  call("POST", `/api/v3/ai/jobs/${jobId}/retry`, options);

async function errorOf(response: Response) {
  return [response.status, ((await response.json()) as { error_code: string }).error_code];
}

const usage = () => memory.state.creditTransactions.filter((entry) => entry.kind === "usage");

async function seedJob({
  userId = USER_ID,
  kind,
  status = "failed",
  inputParams,
  model,
  key,
  file,
}: {
  userId?: string;
  kind: string;
  status?: string;
  inputParams: object;
  model?: string;
  key?: string;
  file?: { name: string; mimeType: string };
}) {
  const created = await createAiJob({
    userId, kind, provider: "openrouter", status, inputParams, usageUnits: 20, model,
    ...(key
      ? { idempotencyKeyHash: await sha256Hex(key), requestFingerprint: "f".repeat(64) }
      : {}),
  });
  const job = memory.state.aiJobs.get(created.id)!;
  if (status === "failed") job.error = "AI image generation failed";
  if (file) {
    const stored = await createFile({
      userId, name: file.name, objectKey: `ai/test/${job.id}`, size: 4,
      mimeType: file.mimeType, visibility: "PRIVATE",
    });
    job.resultFileId = stored.id;
  }
  return job;
}

describe("GET /api/v3/ai/jobs/by-idempotency-key", () => {
  it("answers with the summary GET /ai/jobs/:id gives, in any status", async () => {
    const cases = [
      { kind: "video", status: "queued", inputParams: video, expected: "running" },
      { kind: "image", status: "running", inputParams: image, expected: "running" },
      {
        kind: "image", status: "succeeded", inputParams: image, expected: "succeeded",
        file: { name: "ai-image.png", mimeType: "image/png" },
      },
      { kind: "image", status: "failed", inputParams: image, expected: "failed" },
      {
        kind: "stt", status: "succeeded", expected: "succeeded",
        inputParams: { filename: "voice.wav", durationSeconds: 30 },
        file: { name: "transcription.json", mimeType: "application/json" },
      },
      {
        kind: "translation", status: "succeeded", expected: "succeeded",
        inputParams: { targetLanguage: "ja", segmentCount: 2, characterCount: 20 },
        file: { name: "translation.json", mimeType: "application/json" },
      },
    ];
    for (const [index, { expected, ...seed }] of cases.entries()) {
      const key = `lookup-key-${index}`;
      const job = await seedJob({ ...seed, key });

      const byKey = await call("GET", LOOKUP, { key });
      expect(byKey.status).toBe(200);
      const summary = await byKey.json();
      expect(summary).toEqual(await (await call("GET", `/api/v3/ai/jobs/${job.id}`)).json());
      expect(summary).toMatchObject({
        id: job.id,
        status: expected,
        url: job.resultFileId ? `${ORIGIN}/api/contents/${job.resultFileId}` : null,
      });
    }
  });

  it("answers aiJobNotFound for a key with no job of the caller's", async () => {
    await seedJob({ userId: OTHER_USER_ID, kind: "image", inputParams: image, key: "their-key" });
    for (const key of ["unused-key", "their-key"]) {
      expect(await errorOf(await call("GET", LOOKUP, { key }))).toEqual([404, "aiJobNotFound"]);
    }
  });

  it("answers aiRequestWasDeleted for a deleted job", async () => {
    const job = await seedJob({ kind: "image", status: "succeeded", inputParams: image, key: "deleted-key" });
    expect((await call("DELETE", `/api/v3/ai/jobs/${job.id}`)).status).toBe(200);

    expect(await errorOf(await call("GET", LOOKUP, { key: "deleted-key" })))
      .toEqual([409, "aiRequestWasDeleted"]);
  });

  it("refuses a missing or malformed key and an anonymous caller", async () => {
    for (const key of [undefined, "", "has space", "k".repeat(256)]) {
      expect(await errorOf(await call("GET", LOOKUP, { key }))).toEqual([400, "invalidRequestBody"]);
    }
    expect(await errorOf(await call("GET", LOOKUP, { key: "any-key", anonymous: true })))
      .toEqual([401, "authenticationIsRequired"]);
  });
});

describe("POST /api/v3/ai/jobs/:id/retry", () => {
  it("reruns an image on its model and answers as POST /ai/images", async () => {
    const job = await seedJob({ kind: "image", inputParams: image, model: "dear/model" });

    const response = await retry(job.id, { key: "image-retry" });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      jobId: expect.any(String),
      fileId: expect.any(String),
      url: `${ORIGIN}/api/contents/${body.fileId}`,
      fileName: `ai-image-${body.jobId}.png`,
      contentType: "image/png",
    });
    expect(body.jobId).not.toBe(job.id);
    expect(vi.mocked(generateImage).mock.calls).toEqual([
      [expect.objectContaining({ ...image, model: "dear/model" })],
    ]);
    expect(memory.state.aiJobs.get(body.jobId)).toMatchObject({
      kind: "image", status: "succeeded", provider: "openrouter", model: "dear/model", inputParams: image,
    });
    expect(usage()).toHaveLength(1);
  });

  it("reruns a video on its model and answers as POST /ai/videos", async () => {
    const job = await seedJob({ kind: "video", inputParams: video, model: "dear/video" });

    const response = await retry(job.id, { key: "video-retry" });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      jobId: expect.any(String), status: "running",
      fileId: null, url: null, fileName: null, contentType: null, error: null,
    });
    const [[submitted]] = vi.mocked(createVideoJob).mock.calls;
    expect(submitted).toMatchObject({
      ...video, aspectRatio: "16:9", generateAudio: true, model: "dear/video",
    });
    expect(new URL(submitted.callbackUrl!).pathname)
      .toBe(`/api/v3/ai/videos/${body.jobId}/openrouter-callback`);
    expect(memory.state.aiJobs.get(body.jobId)).toMatchObject({
      kind: "video", model: "dear/video", providerJobId: "provider-video-retry",
    });
    expect(usage()).toHaveLength(1);
  });

  it.each([
    ["image", { kind: "image", inputParams: image, model: "dear/model" }],
    ["video", { kind: "video", inputParams: video, model: "dear/video" }],
  ])("reserves a %s retry once for a repeated key", async (kind, seed) => {
    const job = await seedJob(seed);

    const first = await retry(job.id, { key: `repeat-${kind}` });
    const second = await retry(job.id, { key: `repeat-${kind}` });

    expect(await second.json()).toEqual(await first.json());
    expect(kind === "image" ? generateImage : createVideoJob).toHaveBeenCalledOnce();
    expect(memory.state.aiJobs.size).toBe(2);
    expect(usage()).toHaveLength(1);
  });

  it("answers aiRequestChanged for a key already used for another job", async () => {
    const first = await seedJob({ kind: "image", inputParams: image, model: "dear/model" });
    const other = await seedJob({
      kind: "image", inputParams: { ...image, prompt: "a grey wolf" }, model: "dear/model",
    });
    expect((await retry(first.id, { key: "shared-key" })).status).toBe(200);

    expect(await errorOf(await retry(other.id, { key: "shared-key" })))
      .toEqual([409, "aiRequestChanged"]);
    expect(generateImage).toHaveBeenCalledOnce();
    expect(usage()).toHaveLength(1);
  });

  it.each([
    ["a running job", { kind: "image", status: "running", inputParams: image }, 409, "aiJobIsActive"],
    [
      "an image guided by references",
      { kind: "image", inputParams: { ...image, references: [{ filename: "guide.png" }] } },
      400, "invalidRequestBody",
    ],
    [
      "a video made from frames",
      { kind: "video", inputParams: { ...video, firstFrame: { filename: "first.png", mimeType: "image/png" } } },
      400, "invalidRequestBody",
    ],
    ["a transcription", { kind: "stt", inputParams: { filename: "voice.wav", durationSeconds: 30 } }, 400, "invalidRequestBody"],
    ["another user's job", { kind: "image", inputParams: image, userId: OTHER_USER_ID }, 404, "aiJobNotFound"],
  ] as const)("refuses %s before reserving", async (_, seed, status, errorCode) => {
    const job = await seedJob({ model: "dear/model", ...seed });

    expect(await errorOf(await retry(job.id, { key: crypto.randomUUID() }))).toEqual([status, errorCode]);
    expect(usage()).toHaveLength(0);
    expect(generateImage).not.toHaveBeenCalled();
    expect(createVideoJob).not.toHaveBeenCalled();
  });

  it("does not find a deleted or unknown job", async () => {
    const job = await seedJob({ kind: "image", inputParams: image, model: "dear/model" });
    job.deletedAt = new Date();

    for (const id of [job.id, crypto.randomUUID()]) {
      expect(await errorOf(await retry(id, { key: crypto.randomUUID() }))).toEqual([404, "aiJobNotFound"]);
    }
    expect(usage()).toHaveLength(0);
  });

  it("refuses a model that no longer takes the request or was disabled", async () => {
    const job = await seedJob({ kind: "image", inputParams: image, model: "dear/model" });
    mocks.loadAiImageModelCapabilities.mockResolvedValueOnce(new Map([
      [aiCapabilityKey("openrouter", "dear/model"), {
        modelId: "dear/model", aspectRatios: ["1:1"], backgrounds: ["auto"], seed: true,
        inputReferences: false, maxReferenceImages: 0, resolution: false,
      }],
    ]));
    expect(await errorOf(await retry(job.id, { key: "narrowed-model" })))
      .toEqual([400, "aiModelDoesNotSupportRequest"]);

    await upsertAiOperationModel({
      operation: "image.generate", modelId: "dear/model", displayName: null,
      sortOrder: 0, enabled: false, updatedBy: "admin",
    });
    expect(await errorOf(await retry(job.id, { key: "disabled-model" })))
      .toEqual([400, "aiModelUnavailable"]);
    expect(usage()).toHaveLength(0);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("passes a reservation refusal through", async () => {
    await upsertSubscription({
      userId: USER_ID, stripeSubscriptionId: "sub_ai_retry", status: "canceled", planId: "pro",
      billingOfferId: "offer_pro_test", currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    });
    const job = await seedJob({ kind: "image", inputParams: image, model: "dear/model" });

    expect(await errorOf(await retry(job.id, { key: "no-plan" }))).toEqual([402, "aiPlanRequired"]);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("refunds a failed generation and answers with the provider error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(generateImage).mockRejectedValueOnce(
      new AiProviderError("upstream failure", { httpStatus: 500 }),
    );
    const job = await seedJob({ kind: "image", inputParams: image, model: "dear/model" });

    expect(await errorOf(await retry(job.id, { key: "provider-fails" }))).toEqual([500, "aiProviderError"]);
    const retried = [...memory.state.aiJobs.values()].find((entry) => entry.id !== job.id);
    expect(retried).toMatchObject({ status: "failed" });
    expect(memory.state.creditTransactions.filter((entry) => entry.kind === "refund")).toHaveLength(1);
  });

  it("streams the previews and the result when asked for events", async () => {
    vi.mocked(generateImage).mockImplementationOnce(async (request) => {
      request.onPartialImage?.({ index: 0, b64Json: PNG_BASE64 });
      return { b64Json: PNG_BASE64, mediaType: "image/png" };
    });
    const job = await seedJob({ kind: "image", inputParams: image, model: "dear/model" });

    const response = await retry(job.id, { key: "streamed", accept: "text/event-stream" });

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = await response.text();
    expect(events).toContain("event: partial");
    expect(events).toMatch(/event: result\ndata: \{"jobId":"[^"]+","fileId"/u);
  });

  it("requires a key, a job id and a signed-in caller", async () => {
    const job = await seedJob({ kind: "image", inputParams: image, model: "dear/model" });

    for (const key of [undefined, "has space"]) {
      expect(await errorOf(await retry(job.id, { key }))).toEqual([400, "invalidRequestBody"]);
    }
    expect(await errorOf(await retry("not-a-uuid", { key: "valid-key" })))
      .toEqual([400, "invalidRequestBody"]);
    expect(await errorOf(await retry(job.id, { key: "valid-key", anonymous: true })))
      .toEqual([401, "authenticationIsRequired"]);
    expect(usage()).toHaveLength(0);
  });
});

describe("the job lookup and retry in the Web Worker and the Next.js v3 route", () => {
  type Handler = (request: Request) => Response | Promise<Response>;
  let next: Record<string, Handler>;

  beforeAll(async () => {
    const fromWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
    vi.doMock(fromWeb.resolve("@opennextjs/cloudflare"), () => ({ getCloudflareContext: mocks.context }));
    next = await import("../../apps/web/src/app/api/v3/[[...route]]/route") as unknown as Record<string, Handler>;
  });

  async function both(method: string, path: string, options?: Parameters<typeof headersOf>[0]) {
    const headers = await headersOf(options);
    const request = () => new Request(`${ORIGIN}${path}`, { method, headers });
    const worker = await web.fetch(request(), env, context());
    const route = await next[method](request());
    return { worker, route };
  }
  const snapshot = async (response: Response) => ({ status: response.status, body: await response.text() });

  it("serves the lookup and the refusals identically", async () => {
    const done = await seedJob({ kind: "image", status: "succeeded", inputParams: image, key: "done-key" });
    const active = await seedJob({ kind: "video", status: "running", inputParams: video });
    for (const [method, path, options, status] of [
      ["GET", LOOKUP, { key: "done-key" }, 200],
      ["GET", LOOKUP, { key: "unused-key" }, 404],
      ["GET", LOOKUP, { key: "has space" }, 400],
      ["GET", LOOKUP, { key: "done-key", anonymous: true }, 401],
      ["POST", `/api/v3/ai/jobs/${active.id}/retry`, { key: "active-key" }, 409],
      ["POST", `/api/v3/ai/jobs/${done.id}/retry`, {}, 400],
    ] as const) {
      const { worker, route } = await both(method, path, options);
      const result = await snapshot(worker);
      expect(result).toEqual(await snapshot(route));
      expect(result.status).toBe(status);
    }
    expect(mocks.next).not.toHaveBeenCalled();
  });

  it("answers a repeated retry key on the other entry point with the same job", async () => {
    const job = await seedJob({ kind: "image", inputParams: image, model: "dear/model" });

    const { worker, route } = await both("POST", `/api/v3/ai/jobs/${job.id}/retry`, { key: "both-key" });

    const result = await snapshot(worker);
    expect(result.status).toBe(200);
    expect(result).toEqual(await snapshot(route));
    expect(generateImage).toHaveBeenCalledOnce();
    expect(bucket.put).toHaveBeenCalledOnce();
    expect(usage()).toHaveLength(1);
    expect(mocks.next).not.toHaveBeenCalled();
  });
});
