import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { createHmac } from "node:crypto";
import { createAiJob, setDbProvider } from "@beutl/db";
import {
  addPurchasedCredits,
  consumeUsage,
  getCreditAccount,
  upsertSubscription,
} from "@beutl/db";
import {
  AI_TEXT_RESULT_RETENTION_MILLISECONDS,
  createReservedAiJob,
  reconcileAiJobs,
  setR2BucketProvider,
  v3,
} from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";
import {
  AiProviderError,
  AiVideoSubmissionError,
} from "../../packages/api/src/ai/openrouter";
import {
  MAX_AI_GENERATED_IMAGE_BYTES,
  MAX_AI_GENERATED_IMAGE_DIMENSION,
} from "../../packages/api/src/ai/image-validation";
import {
  MAX_AI_IMAGE_UPLOAD_BYTES,
  MAX_AI_JSON_REQUEST_BYTES,
  MAX_AI_PROMPT_LENGTH,
  MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
  MAX_AI_VIDEO_FRAME_UPLOAD_BYTES,
} from "../../packages/api/src/ai/upload-limits";
import {
  getAiRequestIdentity,
} from "../../packages/api/src/ai/request-integrity";
// Contract tests for the v3 AI endpoints, covering authorization, plan and
// balance failures, and successful response shapes. OpenRouter is mocked.

// v3/ai/images.ts imports the OpenRouter client relatively, so mock the same
// physical module through its test-relative path.
vi.mock("../../packages/api/src/ai/openrouter", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../packages/api/src/ai/openrouter")
  >();
  return {
    ...actual,
    generateImage: vi.fn(),
    editImage: vi.fn(),
    transcribeAudio: vi.fn(),
    createVideoJob: vi.fn(),
    getVideoJob: vi.fn(),
    downloadVideoContent: vi.fn(),
  };
});

import {
  generateImage,
  editImage,
  transcribeAudio,
  createVideoJob,
  getVideoJob,
  downloadVideoContent,
} from "../../packages/api/src/ai/openrouter";

const USER_ID = "user-ai-endpoints";
const JWT_SECRET = "test-secret-for-ai-contract";
const OPENROUTER_WEBHOOK_SECRET = "test-openrouter-webhook-secret";
const PERIOD_START = new Date(Date.now() - 24 * 60 * 60 * 1000);
const PERIOD_END = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const JPEG_BYTES = Uint8Array.from(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z",
    "base64",
  ),
);
const WEBP_BYTES = Uint8Array.from(
  Buffer.from(
    "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=",
    "base64",
  ),
);
const GIF_BYTES = Uint8Array.from(
  Buffer.from(
    "R0lGODdhAQABAIEAAP8AAAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==",
    "base64",
  ),
);
const SVG_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script /></svg>',
);
const PNG_SVG_POLYGLOT = new Uint8Array(PNG_BYTES.length + SVG_BYTES.length);
PNG_SVG_POLYGLOT.set(PNG_BYTES);
PNG_SVG_POLYGLOT.set(SVG_BYTES, PNG_BYTES.length);
const INVALID_GENERATED_JPEG = Uint8Array.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01,
  0xff, 0xda, 0x00, 0x02, 0x01,
  0xff, 0xd9,
]);
const INVALID_GENERATED_WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x20, 0x0a, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00,
]);
const INVALID_INPUT_GIF = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x3b,
]);

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

function testCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) === 1
        ? 0xedb88320 ^ (crc >>> 1)
        : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function oversizedPngDimensions(): Uint8Array {
  const bytes = PNG_BYTES.slice();
  const view = new DataView(bytes.buffer);
  view.setUint32(16, MAX_AI_GENERATED_IMAGE_DIMENSION + 1);
  view.setUint32(29, testCrc32(bytes.subarray(12, 29)));
  return bytes;
}

async function activatePro() {
  await upsertSubscription({
    userId: USER_ID,
    stripeSubscriptionId: "sub_1",
    status: "active",
    planId: "pro",
    billingOfferId: "offer_pro_test",
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    cancelAt: null,
  });
}

function createPcmWav(durationSeconds: number): Uint8Array {
  const sampleRate = 8_000;
  const dataLength = Math.ceil(durationSeconds * sampleRate);
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeAscii(36, "data");
  view.setUint32(40, dataLength, true);
  bytes.fill(128, 44);
  return bytes;
}

function makeApp() {
  return new Hono().basePath("/api/v3").route("/", v3);
}

async function authHeaders(idempotencyKey = crypto.randomUUID()) {
  const token = await sign(
    {
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier":
        USER_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
    },
    JWT_SECRET,
    "HS256",
  );
  return {
    Authorization: `Bearer ${token}`,
    "Idempotency-Key": idempotencyKey,
  };
}

async function getAiRequestIdentityForTest({
  key,
  operation,
  input,
}: {
  key: string;
  operation: string;
  input: unknown;
}) {
  const identity = await getAiRequestIdentity({
    request: new Request("http://localhost", {
      headers: { "Idempotency-Key": key },
    }),
    operation,
    input,
  });
  if (!identity) throw new Error("Test idempotency identity is invalid");
  return identity;
}

function expectOpaqueCallbackUrl(value: string, jobId: string): URL {
  const callbackUrl = new URL(value);
  expect(callbackUrl.origin).toBe("https://beutl.beditor.net");
  expect(callbackUrl.pathname).toBe(
    `/api/v3/ai/videos/${jobId}/openrouter-callback`,
  );
  expect([...callbackUrl.searchParams.keys()]).toEqual(["nonce"]);
  expect(callbackUrl.searchParams.get("nonce")).toMatch(/^[0-9a-f]{64}$/);
  return callbackUrl;
}

function signedOpenRouterWebhook(
  body: string,
  timestamp = Math.floor(Date.now() / 1_000).toString(),
) {
  const signature = createHmac("sha256", OPENROUTER_WEBHOOK_SECRET)
    .update(`${timestamp},${body}`)
    .digest("hex");
  return {
    "content-type": "application/json",
    "X-OpenRouter-Signature": `t=${timestamp},v1=${signature}`,
    "X-OpenRouter-Idempotency-Key": "video-test-completed",
  };
}

async function requestChunkedForm(path: string, form: FormData) {
  const encoded = new Request("http://form-encoder.invalid", {
    method: "POST",
    body: form,
  });
  const contentType = encoded.headers.get("content-type");
  if (!contentType) throw new Error("FormData encoder omitted Content-Type");
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 17, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  return await makeApp().fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": contentType,
        ...(await authHeaders()),
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
  );
}

async function requestOversizedChunkedBody({
  path,
  maximumBytes,
  forgedContentLength,
}: {
  path: string;
  maximumBytes: number;
  forgedContentLength?: string;
}) {
  const chunk = new Uint8Array(1024 * 1024);
  let chunksRead = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunksRead++;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await makeApp().fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=stream-limit-test",
        ...(forgedContentLength
          ? { "content-length": forgedContentLength }
          : {}),
        ...(await authHeaders()),
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
  );
  return {
    response,
    chunksRead,
    cancelled,
    maximumExpectedChunks: Math.ceil((maximumBytes + 64 * 1024) / chunk.length) + 1,
  };
}

describe("v3 AI endpoints contract", () => {
  let prisma: ReturnType<typeof createInMemoryPrisma>["prisma"];
  let state: ReturnType<typeof createInMemoryPrisma>["state"];
  let putObject: ReturnType<typeof vi.fn>;
  let deleteObject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    const memory = createInMemoryPrisma();
    prisma = memory.prisma;
    state = memory.state;
    setDbProvider(async () => prisma as never);
    putObject = vi.fn().mockResolvedValue(undefined);
    deleteObject = vi.fn().mockResolvedValue(undefined);
    setR2BucketProvider(() => ({
      put: putObject,
      delete: deleteObject,
    }));
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.PUBLIC_ORIGIN = "https://beutl.beditor.net";
    process.env.OPENROUTER_WEBHOOK_SECRET = OPENROUTER_WEBHOOK_SECRET;
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.PUBLIC_ORIGIN;
    delete process.env.OPENROUTER_WEBHOOK_SECRET;
  });

  describe("GET /api/v3/user/entitlements", () => {
    it("never exposes usage costs or raw balances to the client", async () => {
      await activatePro();
      await addPurchasedCredits({
        userId: USER_ID,
        amount: 100,
        stripePaymentId: "pi_leak_guard",
      });
      await consumeUsage({
        userId: USER_ID,
        amount: 20,
        usagePeriod: { start: PERIOD_START, end: PERIOD_END },
        monthlyUsageLimit: 500,
      });

      const res = await makeApp().request("/api/v3/user/entitlements", {
        headers: await authHeaders(),
      });
      expect(res.status).toBe(200);
      const serialized = JSON.stringify(await res.json());

      // Raw allowance and debt units stay server-side. The exact purchased-credit
      // balance remains an intentional account-only surface; operation responses
      // are checked separately to expose only its presence.
      for (const forbidden of [
        "pricing",
        "usageUnits",
        "\"used\"",
        "\"limit\"",
        "additionalCreditDebt\"",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it("returns 401 authenticationIsRequired when unauthenticated", async () => {
      const res = await makeApp().request("/api/v3/user/entitlements");
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error_code: "authenticationIsRequired",
      });
    });

    it("returns the monthly allowance and additional credits for Pro subscribers", async () => {
      await activatePro();
      await addPurchasedCredits({
        userId: USER_ID,
        amount: 100,
        stripePaymentId: "pi_1",
      });

      const res = await makeApp().request("/api/v3/user/entitlements", {
        headers: await authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        plan: "pro",
        subscriptionStatus: "active",
        currentPeriodStart: expect.any(String),
        currentPeriodEnd: expect.any(String),
        cancelAtPeriodEnd: false,
        canUseAi: true,
        balance: {
          monthlyUsage: {
            usedPercent: 0,
            remainingPercent: 100,
            isExhausted: false,
          },
          additionalCredits: 100,
          hasAdditionalCreditDebt: false,
        },
        availability: expect.any(Object),
      });
    });

    it("uses an earlier custom cancellation date as the access end", async () => {
      const cancelAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
      await upsertSubscription({
        userId: USER_ID,
        stripeSubscriptionId: "sub_custom_cancel",
        status: "active",
        planId: "pro",
        billingOfferId: "offer_pro_test",
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
        cancelAtPeriodEnd: true,
        cancelAt,
      });

      const res = await makeApp().request("/api/v3/user/entitlements", {
        headers: await authHeaders(),
      });

      expect(await res.json()).toMatchObject({
        canUseAi: true,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: cancelAt.toISOString(),
      });
    });

    it("fails closed once a custom cancellation date has passed", async () => {
      await upsertSubscription({
        userId: USER_ID,
        stripeSubscriptionId: "sub_custom_cancel_elapsed",
        status: "active",
        planId: "pro",
        billingOfferId: "offer_pro_test",
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
        cancelAtPeriodEnd: true,
        cancelAt: new Date(Date.now() - 1_000),
      });

      const res = await makeApp().request("/api/v3/user/entitlements", {
        headers: await authHeaders(),
      });

      expect(await res.json()).toMatchObject({
        plan: null,
        subscriptionStatus: "active",
        canUseAi: false,
      });
    });

    it("returns a null plan without a subscription", async () => {
      const res = await makeApp().request("/api/v3/user/entitlements", {
        headers: await authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        plan: null,
        subscriptionStatus: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        canUseAi: false,
        balance: {
          monthlyUsage: {
            usedPercent: 0,
            remainingPercent: 100,
            isExhausted: true,
          },
          additionalCredits: 0,
          hasAdditionalCreditDebt: false,
        },
        availability: expect.any(Object),
      });
    });

    it("resets only monthly usage when the billing period changes", async () => {
      await activatePro();
      await addPurchasedCredits({
        userId: USER_ID,
        amount: 100,
        stripePaymentId: "pi_1",
      });
      await consumeUsage({
        userId: USER_ID,
        amount: 120,
        monthlyUsageLimit: 500,
        usagePeriod: { start: PERIOD_START, end: PERIOD_END },
        aiJobId: "setup-job",
      });
      const nextPeriodEnd = new Date(
        PERIOD_END.getTime() + 30 * 24 * 60 * 60 * 1000,
      );
      await upsertSubscription({
        userId: USER_ID,
        stripeSubscriptionId: "sub_1",
        status: "active",
        planId: "pro",
        billingOfferId: "offer_pro_test",
        currentPeriodStart: PERIOD_END,
        currentPeriodEnd: nextPeriodEnd,
      });

      const res = await makeApp().request("/api/v3/user/entitlements", {
        headers: await authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        canUseAi: true,
        balance: {
          monthlyUsage: {
            usedPercent: 0,
            remainingPercent: 100,
            isExhausted: false,
          },
          additionalCredits: 100,
        },
      });
    });

    it("preserves additional credits after cancellation", async () => {
      await upsertSubscription({
        userId: USER_ID,
        stripeSubscriptionId: "sub_1",
        status: "canceled",
        planId: "pro",
        billingOfferId: "offer_pro_test",
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
      });
      await addPurchasedCredits({
        userId: USER_ID,
        amount: 100,
        stripePaymentId: "pi_1",
      });

      const res = await makeApp().request("/api/v3/user/entitlements", {
        headers: await authHeaders(),
      });
      expect(await res.json()).toMatchObject({
        plan: null,
        subscriptionStatus: "canceled",
        canUseAi: false,
        balance: {
          monthlyUsage: {
            usedPercent: 0,
            remainingPercent: 100,
            isExhausted: true,
          },
          additionalCredits: 100,
        },
      });
    });

    it("returns subscription states that require payment attention", async () => {
      await upsertSubscription({
        userId: USER_ID,
        stripeSubscriptionId: "sub_1",
        status: "past_due",
        planId: "pro",
        billingOfferId: "offer_pro_test",
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
      });

      const res = await makeApp().request("/api/v3/user/entitlements", {
        headers: await authHeaders(),
      });
      expect(await res.json()).toMatchObject({
        plan: null,
        subscriptionStatus: "past_due",
        canUseAi: false,
        balance: {
          monthlyUsage: {
            usedPercent: 0,
            remainingPercent: 100,
            isExhausted: true,
          },
        },
      });
    });
  });

  describe("POST /api/v3/ai/images", () => {
    it("returns 401 authenticationIsRequired when unauthenticated", async () => {
      const res = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "test", size: "1024x1024" }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error_code: "authenticationIsRequired",
      });
    });

    it("returns 402 aiPlanRequired without Pro", async () => {
      const res = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", size: "1024x1024" }),
      });
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({
        error_code: "aiPlanRequired",
      });
      expect(state.aiJobs.size).toBe(0);
    });

    it("requires an idempotency key before reserving paid usage", async () => {
      await activatePro();

      const response = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: (await authHeaders()).Authorization,
        },
        body: JSON.stringify({ prompt: "test", size: "1024x1024" }),
      });

      expect(response.status).toBe(400);
      expect(state.aiJobs.size).toBe(0);
      expect(state.creditTransactions).toHaveLength(0);
      expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
    });

    it("replays a completed request without invoking the provider or charging twice", async () => {
      await activatePro();
      vi.mocked(generateImage).mockResolvedValue({
        b64Json: Buffer.from(PNG_BYTES).toString("base64"),
        mediaType: "image/png",
      });
      const headers = {
        "content-type": "application/json",
        ...(await authHeaders("image-replay-key")),
      };
      const request = () => makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "test", size: "1024x1024" }),
      });

      const first = await request();
      const second = await request();

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(await first.json());
      expect(vi.mocked(generateImage)).toHaveBeenCalledOnce();
      expect(state.aiJobs.size).toBe(1);
      expect(
        state.creditTransactions.filter(transaction => transaction.kind === "usage"),
      ).toHaveLength(1);
    });

    it("does not invoke the provider or charge again after idempotent history is deleted", async () => {
      await activatePro();
      vi.mocked(generateImage).mockResolvedValue({
        b64Json: Buffer.from(PNG_BYTES).toString("base64"),
        mediaType: "image/png",
      });
      const headers = {
        "content-type": "application/json",
        ...(await authHeaders("image-deleted-replay-key")),
      };
      const request = () => makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "deleted replay", size: "1024x1024" }),
      });

      const first = await request();
      expect(first.status).toBe(200);
      const firstPayload = await first.json() as { jobId: string };
      const deleted = await makeApp().request(
        `/api/v3/ai/jobs/${firstPayload.jobId}`,
        { method: "DELETE", headers: await authHeaders() },
      );
      expect(deleted.status).toBe(200);

      const replay = await request();
      expect(replay.status).toBe(409);
      expect(await replay.json()).toMatchObject({
        error_code: "aiRequestWasDeleted",
      });
      expect(vi.mocked(generateImage)).toHaveBeenCalledOnce();
      expect(state.aiJobs.size).toBe(1);
      expect(
        state.creditTransactions.filter(transaction => transaction.kind === "usage"),
      ).toHaveLength(1);
    });

    it("returns a typed conflict while an idempotent request is still running", async () => {
      await activatePro();
      const key = "image-running-replay-key";
      const reservation = await createReservedAiJob({
        userId: USER_ID,
        kind: "image",
        provider: "openrouter",
        status: "running",
        inputParams: { prompt: "test", size: "1024x1024" },
        usageUnits: 20,
        ...(await getAiRequestIdentityForTest({
          key,
          operation: "image.generate",
          input: { prompt: "test", size: "1024x1024" },
        })),
      });
      expect(reservation.ok).toBe(true);

      const response = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(key)),
        },
        body: JSON.stringify({ prompt: "test", size: "1024x1024" }),
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error_code: "aiRequestInProgress",
      });
      expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
      expect(
        state.creditTransactions.filter(transaction => transaction.kind === "usage"),
      ).toHaveLength(1);
    });

    it("rejects reuse of an idempotency key for a different request", async () => {
      await activatePro();
      vi.mocked(generateImage).mockResolvedValue({
        b64Json: Buffer.from(PNG_BYTES).toString("base64"),
        mediaType: "image/png",
      });
      const headers = {
        "content-type": "application/json",
        ...(await authHeaders("image-conflict-key")),
      };
      const first = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "first", size: "1024x1024" }),
      });
      const conflicting = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "second", size: "1024x1024" }),
      });

      expect(first.status).toBe(200);
      expect(conflicting.status).toBe(409);
      expect(state.aiJobs.size).toBe(1);
      expect(vi.mocked(generateImage)).toHaveBeenCalledOnce();
      expect(
        state.creditTransactions.filter(transaction => transaction.kind === "usage"),
      ).toHaveLength(1);
    });

    it("rejects an overlong image prompt before reserving usage", async () => {
      await activatePro();

      const response = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({
          prompt: "x".repeat(MAX_AI_PROMPT_LENGTH + 1),
          size: "1024x1024",
        }),
      });

      expect(response.status).toBe(400);
      expect(state.aiJobs.size).toBe(0);
      expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
    });

    it("caps the image JSON body before parsing", async () => {
      await activatePro();

      const response = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({
          prompt: "test",
          size: "1024x1024",
          padding: "x".repeat(MAX_AI_JSON_REQUEST_BYTES),
        }),
      });

      expect(response.status).toBe(413);
      expect(state.aiJobs.size).toBe(0);
      expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
    });

    it("returns 402 aiUsageLimitExceeded when all usage sources are insufficient", async () => {
      await activatePro();
      await consumeUsage({
        userId: USER_ID,
        amount: 490,
        monthlyUsageLimit: 500,
        usagePeriod: { start: PERIOD_START, end: PERIOD_END },
        aiJobId: "setup-job",
      });

      const res = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "  test  ", size: "1024x1024" }),
      });
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({
        error_code: "aiUsageLimitExceeded",
      });
      expect(state.aiJobs.size).toBe(0);
    });

    it("returns the balance after consuming monthly usage", async () => {
      await activatePro();

      // 1x1 PNG encoded as base64.
      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      vi.mocked(generateImage).mockResolvedValue({
        b64Json: pngB64,
        mediaType: "image/png",
      });

      const res = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", size: "1024x1024" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        jobId: expect.any(String),
        fileId: expect.any(String),
        url: `https://beutl.beditor.net/api/contents/${body.fileId}`,
        fileName: `ai-image-${body.jobId}.png`,
        contentType: "image/png",
      });
      expect(body).not.toHaveProperty("balance");
      expectOperationResponseToHideUsage(body);

      // Credits are consumed and the job reaches succeeded.
      const job = [...state.aiJobs.values()][0];
      expect(job).toMatchObject({
        kind: "image",
        status: "succeeded",
        inputParams: { prompt: "test", size: "1024x1024" },
        usageUnits: 20,
        resultFileId: body.fileId,
      });
      expect(state.files.size).toBe(1);
      expect(vi.mocked(generateImage)).toHaveBeenCalledWith({
        prompt: "test",
        size: "1024x1024",
        model: "openai/gpt-image-1",
        signal: expect.any(AbortSignal),
      });
      expect(
        state.creditTransactions.some(
          (t) =>
            t.kind === "usage" &&
            t.usageAmount === 20 &&
            t.creditAmount === 0 &&
            t.aiJobId === job.id,
        ),
      ).toBe(true);
    });

    it("consumes additional credits after exhausting monthly usage", async () => {
      await activatePro();
      await addPurchasedCredits({
        userId: USER_ID,
        amount: 100,
        stripePaymentId: "pi_1",
      });
      await consumeUsage({
        userId: USER_ID,
        amount: 495,
        monthlyUsageLimit: 500,
        usagePeriod: { start: PERIOD_START, end: PERIOD_END },
        aiJobId: "setup-job",
      });
      vi.mocked(generateImage).mockResolvedValue({
        b64Json:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        mediaType: "image/png",
      });

      const res = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", size: "1024x1024" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).not.toHaveProperty("balance");
      const usage = state.creditTransactions.find(
        (transaction) =>
          transaction.kind === "usage" && transaction.aiJobId !== "setup-job",
      );
      expect(usage).toMatchObject({
        usageAmount: 5,
        creditAmount: -15,
      });
    });

    it("returns 500 aiProviderError and refunds usage when OpenRouter fails", async () => {
      await activatePro();
      vi.mocked(generateImage).mockRejectedValue(
        new AiProviderError("OpenRouter request failed: 500"),
      );

      const res = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", size: "1024x1024" }),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({
        error_code: "aiProviderError",
      });
      expect([...state.aiJobs.values()][0]).toMatchObject({
        status: "failed",
        error: "AI image generation failed",
      });
      expect(JSON.stringify([...state.aiJobs.values()][0])).not.toContain(
        "OpenRouter request failed: 500",
      );
      // Both the reservation and refund are recorded.
      expect(
        state.creditTransactions.some(
          (t) => t.kind === "usage" && t.usageAmount === 20,
        ),
      ).toBe(true);
      expect(
        state.creditTransactions.some(
          (t) => t.kind === "refund" && t.usageAmount === -20,
        ),
      ).toBe(true);
      // The balance is restored.
      const account = await getCreditAccount({ userId: USER_ID });
      expect(account.monthlyUsageUsed).toBe(0);
      expect(account.purchasedCredits).toBe(0);
    });

    it("refunds usage when the provider execution outcome is unknown", async () => {
      await activatePro();
      vi.mocked(generateImage).mockRejectedValue(
        new AiProviderError("OpenRouter request timed out", {
          execution: "unknown",
        }),
      );

      const response = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", size: "1024x1024" }),
      });

      expect(response.status).toBe(500);
      expect([...state.aiJobs.values()][0]).toMatchObject({ status: "failed" });
      expect(
        state.creditTransactions.filter(transaction => transaction.kind === "refund"),
      ).toHaveLength(1);
      expect((await getCreditAccount({ userId: USER_ID })).monthlyUsageUsed)
        .toBe(0);
    });

    it.each([
      {
        name: "declared MIME mismatch",
        bytes: () => PNG_BYTES,
        mediaType: "image/jpeg",
      },
      {
        name: "corrupt image data",
        bytes: () => PNG_BYTES.slice(0, -1),
        mediaType: "image/png",
      },
      {
        name: "oversized dimensions",
        bytes: oversizedPngDimensions,
        mediaType: "image/png",
      },
      {
        name: "JPEG with arbitrary entropy",
        bytes: () => INVALID_GENERATED_JPEG,
        mediaType: "image/jpeg",
      },
      {
        name: "WebP with an incomplete VP8 bitstream",
        bytes: () => INVALID_GENERATED_WEBP,
        mediaType: "image/webp",
      },
    ])("rejects generated $name before storage and refunds usage", async ({
      bytes,
      mediaType,
    }) => {
      await activatePro();
      vi.mocked(generateImage).mockResolvedValue({
        b64Json: Buffer.from(bytes()).toString("base64"),
        mediaType,
      });

      const response = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", size: "1024x1024" }),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error_code: "aiProviderError",
      });
      expect(putObject).not.toHaveBeenCalled();
      expect(state.files.size).toBe(0);
      expect(state.aiStorageCleanups.size).toBe(0);
      expect([...state.aiJobs.values()][0]?.status).toBe("failed");
      expect(
        state.creditTransactions.filter((item) => item.kind === "refund"),
      ).toHaveLength(1);
    });

    it("rejects an oversized generated image before storage", async () => {
      await activatePro();
      vi.mocked(generateImage).mockResolvedValue({
        b64Json: Buffer.alloc(MAX_AI_GENERATED_IMAGE_BYTES + 1).toString(
          "base64",
        ),
        mediaType: "image/png",
      });

      const response = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", size: "1024x1024" }),
      });

      expect(response.status).toBe(500);
      expect(putObject).not.toHaveBeenCalled();
      expect(state.files.size).toBe(0);
      expect([...state.aiJobs.values()][0]?.status).toBe("failed");
      expect(
        state.creditTransactions.filter((item) => item.kind === "refund"),
      ).toHaveLength(1);
    });

    it("deletes the R2 object when digest calculation fails after put", async () => {
      await activatePro();
      vi.mocked(generateImage).mockResolvedValue({
        b64Json: Buffer.from(PNG_BYTES).toString("base64"),
        mediaType: "image/png",
      });
      const headers = await authHeaders();
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let digestCalls = 0;
      vi.spyOn(crypto.subtle, "digest").mockImplementation(
        async (...args: Parameters<typeof crypto.subtle.digest>) => {
          digestCalls++;
          if (digestCalls === 3) throw new Error("digest unavailable");
          return await digest(...args);
        },
      );
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const response = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ prompt: "test", size: "1024x1024" }),
      });

      expect(response.status).toBe(500);
      expect(putObject).toHaveBeenCalledOnce();
      expect(deleteObject).toHaveBeenCalledOnce();
      expect(state.files.size).toBe(0);
      expect(state.aiStorageCleanups.size).toBe(0);
      expect([...state.aiJobs.values()][0]?.status).toBe("failed");
      consoleError.mockRestore();
    });

    it("durably reconciles an orphan when DB commit and immediate R2 delete fail", async () => {
      await activatePro();
      vi.mocked(generateImage).mockResolvedValue({
        b64Json: Buffer.from(PNG_BYTES).toString("base64"),
        mediaType: "image/png",
      });
      vi.spyOn(prisma.file, "create").mockRejectedValueOnce(
        new Error("database write failed"),
      );
      deleteObject.mockRejectedValueOnce(new Error("R2 unavailable"));
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const response = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", size: "1024x1024" }),
      });

      expect(response.status).toBe(500);
      expect(putObject).toHaveBeenCalledOnce();
      expect(deleteObject).toHaveBeenCalledOnce();
      expect(state.files.size).toBe(0);
      expect(state.aiStorageCleanups.size).toBe(1);
      expect([...state.aiJobs.values()][0]?.status).toBe("failed");

      const reconciled = await reconcileAiJobs(
        new Date(Date.now() + 1_000),
      );
      expect(reconciled).toMatchObject({
        cleanupInspected: 1,
        cleanupDeleted: 1,
        cleanupErrors: 0,
      });
      expect(deleteObject).toHaveBeenCalledTimes(2);
      expect(state.aiStorageCleanups.size).toBe(0);
      consoleError.mockRestore();
    });

    it("does not delete an output after an ambiguously successful DB commit", async () => {
      await activatePro();
      vi.mocked(generateImage).mockResolvedValue({
        b64Json: Buffer.from(PNG_BYTES).toString("base64"),
        mediaType: "image/png",
      });
      const originalTransaction = prisma.$transaction.bind(prisma);
      let transactionCalls = 0;
      vi.spyOn(prisma, "$transaction").mockImplementation(async (callback) => {
        const result = await originalTransaction(callback);
        transactionCalls++;
        if (transactionCalls === 2) {
          throw new Error("connection lost after commit");
        }
        return result;
      });

      const response = await makeApp().request("/api/v3/ai/images", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", size: "1024x1024" }),
      });

      expect(response.status).toBe(200);
      expect(putObject).toHaveBeenCalledOnce();
      expect(deleteObject).not.toHaveBeenCalled();
      expect(state.files.size).toBe(1);
      expect(state.aiStorageCleanups.size).toBe(0);
      expect([...state.aiJobs.values()][0]?.status).toBe("succeeded");
      expect(
        state.creditTransactions.filter((item) => item.kind === "refund"),
      ).toHaveLength(0);
    });
  });

  describe("POST /api/v3/ai/images/edit", () => {
    it("returns 401 authenticationIsRequired when unauthenticated", async () => {
      const form = new FormData();
      form.append("task", "remove_background");
      form.append("file", new File([PNG_BYTES], "a.png", { type: "image/png" }));
      const res = await makeApp().request("/api/v3/ai/images/edit", {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error_code: "authenticationIsRequired",
      });
    });

    it("returns 402 aiPlanRequired before parsing the file without Pro", async () => {
      const form = new FormData();
      form.append("task", "remove_background");
      form.append("file", new File([new Uint8Array(8)], "invalid.bin"));
      const res = await makeApp().request("/api/v3/ai/images/edit", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });

      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ error_code: "aiPlanRequired" });
    });

    it("returns 413 when Content-Length exceeds the image upload limit", async () => {
      await activatePro();
      const res = await makeApp().request("/api/v3/ai/images/edit", {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=test",
          "content-length": String(MAX_AI_IMAGE_UPLOAD_BYTES + 64 * 1024 + 1),
          ...(await authHeaders()),
        },
        body: "--test--",
      });

      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error_code: "fileIsTooLarge" });
    });

    it("returns the response contract and consumes the task-specific cost", async () => {
      await activatePro();
      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      vi.mocked(editImage).mockResolvedValue({
        b64Json: pngB64,
        mediaType: "image/png",
      });

      const form = new FormData();
      form.append("task", "remove_background");
      form.append("file", new File([PNG_BYTES], "a.png", { type: "image/png" }));
      const res = await makeApp().request("/api/v3/ai/images/edit", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        jobId: expect.any(String),
        fileId: expect.any(String),
        url: `https://beutl.beditor.net/api/contents/${body.fileId}`,
        fileName: `ai-edit-${body.jobId}.png`,
        contentType: "image/png",
      });
      expect(body).not.toHaveProperty("balance");
      expectOperationResponseToHideUsage(body);
      const job = [...state.aiJobs.values()][0];
      expect(job).toMatchObject({
        kind: "image_edit",
        status: "succeeded",
        usageUnits: 10,
      });
      expect(vi.mocked(editImage)).toHaveBeenCalledWith({
        task: "remove_background",
        image: expect.any(ArrayBuffer),
        mimeType: "image/png",
        model: "openai/gpt-image-1",
        signal: expect.any(AbortSignal),
      });
    });

    it.each([
      ["restyle", "Restyle this portrait as a charcoal drawing"],
      ["remove_object", "Remove the lamp from the table"],
      ["outpaint", "Extend the forest beyond the left and right edges"],
    ] as const)(
      "%s reserves usage and sends the user prompt with the reference image",
      async (task, prompt) => {
        await activatePro();
        vi.mocked(editImage).mockResolvedValue({
          b64Json:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          mediaType: "image/png",
        });

        const form = new FormData();
        form.append("task", task);
        form.append("prompt", `  ${prompt}  `);
        form.append(
          "file",
          new File([WEBP_BYTES], "source.webp", {
            type: "image/webp",
          }),
        );
        const res = await makeApp().request("/api/v3/ai/images/edit", {
          method: "POST",
          headers: await authHeaders(),
          body: form,
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).not.toHaveProperty("balance");
        expect(vi.mocked(editImage)).toHaveBeenCalledOnce();
        const request = vi.mocked(editImage).mock.calls[0][0];
        expect(request).toMatchObject({
          task,
          mimeType: "image/webp",
          prompt,
        });
        expect(new Uint8Array(request.image)).toEqual(WEBP_BYTES);
        expect([...state.aiJobs.values()][0]).toMatchObject({
          kind: "image_edit",
          status: "succeeded",
          inputParams: {
            task,
            filename: "source.webp",
            prompt,
          },
          usageUnits: 20,
        });
      },
    );

    it.each(["restyle", "remove_object", "outpaint"] as const)(
      "%s rejects an empty prompt before charging",
      async (task) => {
        await activatePro();
        const form = new FormData();
        form.append("task", task);
        form.append("prompt", "   ");
        form.append(
          "file",
          new File([new Uint8Array(8)], "a.png", { type: "image/png" }),
        );

        const res = await makeApp().request("/api/v3/ai/images/edit", {
          method: "POST",
          headers: await authHeaders(),
          body: form,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          error_code: "invalidRequestBody",
        });
        expect(state.aiJobs.size).toBe(0);
        expect(state.creditTransactions).toHaveLength(0);
        expect(vi.mocked(editImage)).not.toHaveBeenCalled();
      },
    );

    it("rejects an overlong multipart image-edit prompt before reserving usage", async () => {
      await activatePro();
      const form = new FormData();
      form.append("task", "restyle");
      form.append("prompt", "x".repeat(MAX_AI_PROMPT_LENGTH + 1));
      form.append(
        "file",
        new File([PNG_BYTES], "source.png", { type: "image/png" }),
      );

      const response = await makeApp().request("/api/v3/ai/images/edit", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });

      expect(response.status).toBe(400);
      expect(state.aiJobs.size).toBe(0);
      expect(vi.mocked(editImage)).not.toHaveBeenCalled();
    });

    it("rejects an unsupported image MIME type before charging", async () => {
      await activatePro();
      const form = new FormData();
      form.append("task", "restyle");
      form.append("prompt", "Use an ink-wash style");
      form.append(
        "file",
        new File([new Uint8Array(8)], "source.png", {
          type: "text/plain",
        }),
      );

      const res = await makeApp().request("/api/v3/ai/images/edit", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });

      expect(res.status).toBe(400);
      expect(state.aiJobs.size).toBe(0);
      expect(state.creditTransactions).toHaveLength(0);
      expect(vi.mocked(editImage)).not.toHaveBeenCalled();
    });

    it.each([
      ["empty image", new Uint8Array(), "empty.png", "image/png"],
      ["disguised SVG", SVG_BYTES, "source.png", "image/png"],
      ["declared MIME mismatch", PNG_BYTES, "source.jpg", "image/jpeg"],
      ["extension mismatch", PNG_BYTES, "source.jpg", "image/png"],
      ["PNG/SVG polyglot", PNG_SVG_POLYGLOT, "source.png", "image/png"],
      ["truncated JPEG", INVALID_GENERATED_JPEG, "source.jpg", "image/jpeg"],
      ["truncated WebP", INVALID_GENERATED_WEBP, "source.webp", "image/webp"],
      ["header-only GIF", INVALID_INPUT_GIF, "source.gif", "image/gif"],
      [
        "unsupported BMP",
        Uint8Array.from([0x42, 0x4d, 0x00, 0x00]),
        "source.bmp",
        "image/bmp",
      ],
    ])("rejects %s bytes before reserving usage", async (_, bytes, name, type) => {
      await activatePro();
      const form = new FormData();
      form.append("task", "remove_background");
      form.append("file", new File([bytes], name, { type }));

      const response = await makeApp().request("/api/v3/ai/images/edit", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error_code: "invalidRequestBody",
      });
      expect(state.aiJobs.size).toBe(0);
      expect(state.creditTransactions).toHaveLength(0);
      expect(vi.mocked(editImage)).not.toHaveBeenCalled();
    });

    it("accepts a byte-sniffed GIF on the edit route", async () => {
      await activatePro();
      vi.mocked(editImage).mockResolvedValue({
        b64Json:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        mediaType: "image/png",
      });
      const form = new FormData();
      form.append("task", "remove_background");
      form.append(
        "file",
        new File([GIF_BYTES], "source.gif", { type: "image/gif" }),
      );

      const response = await makeApp().request("/api/v3/ai/images/edit", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });

      expect(response.status).toBe(200);
      expect(vi.mocked(editImage)).toHaveBeenCalledWith({
        task: "remove_background",
        image: expect.any(ArrayBuffer),
        mimeType: "image/gif",
        model: "openai/gpt-image-1",
        signal: expect.any(AbortSignal),
      });
      expect(
        new Uint8Array(vi.mocked(editImage).mock.calls[0][0].image),
      ).toEqual(GIF_BYTES);
    });

    it("returns 400 invalidRequestBody for an invalid task", async () => {
      await activatePro();
      const form = new FormData();
      form.append("task", "unknown_task");
      form.append("file", new File([new Uint8Array(8)], "a.png", { type: "image/png" }));
      const res = await makeApp().request("/api/v3/ai/images/edit", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error_code: "invalidRequestBody",
      });
      expect(state.aiJobs.size).toBe(0);
      expect(state.creditTransactions).toHaveLength(0);
      expect(vi.mocked(editImage)).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/v3/ai/transcriptions", () => {
    it("returns 401 authenticationIsRequired when unauthenticated", async () => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(8)], "a.mp3", { type: "audio/mpeg" }));
      const res = await makeApp().request("/api/v3/ai/transcriptions", {
        method: "POST",
        body: form,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error_code: "authenticationIsRequired",
      });
    });

    it("returns 402 aiPlanRequired before parsing audio without Pro", async () => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(8)], "invalid.mp3"));
      const res = await makeApp().request("/api/v3/ai/transcriptions", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });

      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ error_code: "aiPlanRequired" });
    });

    it("returns 413 when Content-Length exceeds the audio upload limit", async () => {
      await activatePro();
      const res = await makeApp().request("/api/v3/ai/transcriptions", {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=test",
          "content-length": String(
            MAX_AI_TRANSCRIPTION_UPLOAD_BYTES + 64 * 1024 + 1,
          ),
          ...(await authHeaders()),
        },
        body: "--test--",
      });

      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error_code: "fileIsTooLarge" });
    });

    it("returns 400 invalidRequestBody for unparseable audio", async () => {
      await activatePro();
      const form = new FormData();
      form.append("file", new File([new Uint8Array(8)], "a.mp3", { type: "audio/mpeg" }));
      const res = await makeApp().request("/api/v3/ai/transcriptions", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error_code: "invalidRequestBody",
      });
    });

    it.each(["eng", "zz"])(
      "rejects invalid language code %s before charging",
      async (language) => {
        await activatePro();
        const form = new FormData();
        form.append(
          "file",
          new File([createPcmWav(1)], "a.wav", { type: "audio/wav" }),
        );
        form.append("language", language);

        const res = await makeApp().request(
          "/api/v3/ai/transcriptions",
          {
            method: "POST",
            headers: await authHeaders(),
            body: form,
          },
        );

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          error_code: "invalidRequestBody",
        });
        expect(state.aiJobs.size).toBe(0);
        expect(state.creditTransactions).toHaveLength(0);
        expect(vi.mocked(transcribeAudio)).not.toHaveBeenCalled();
      },
    );

    it("returns segments and five usage units per started minute", async () => {
      await activatePro();
      vi.mocked(transcribeAudio).mockResolvedValue({
        segments: [
          { start: 0.0, end: 2.5, text: "Hello world" },
          { start: 2.5, end: 5.0, text: "Second line" },
        ],
      });

      const form = new FormData();
      form.append("file", new File([createPcmWav(65)], "a.wav", { type: "audio/wav" }));
      const res = await makeApp().request("/api/v3/ai/transcriptions", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        segments: [
          { start: 0.0, end: 2.5, text: "Hello world" },
          { start: 2.5, end: 5.0, text: "Second line" },
        ],
      });
      expect(body).not.toHaveProperty("balance");
      expect(body).not.toHaveProperty("language");
      expect(body).not.toHaveProperty("words");
      expectOperationResponseToHideUsage(body);

      const job = [...state.aiJobs.values()][0];
      expect(job).toMatchObject({
        kind: "stt",
        status: "succeeded",
        usageUnits: 10,
        resultFileId: expect.any(String),
      });
      expect(putObject).toHaveBeenCalledOnce();
      const [objectKey, storedBytes, metadata] = putObject.mock.calls[0];
      expect(objectKey).toMatch(new RegExp(`^ai/text/${job.id}/`));
      expect(metadata).toEqual({
        httpMetadata: { contentType: "application/json" },
      });
      expect(JSON.parse(new TextDecoder().decode(storedBytes))).toEqual({
        version: 1,
        kind: "stt",
        segments: [
          { start: 0, end: 2.5, text: "Hello world" },
          { start: 2.5, end: 5, text: "Second line" },
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
        state.creditTransactions.some(
          (t) =>
            t.kind === "usage" &&
            t.usageAmount === 10 &&
            t.aiJobId === job.id,
        ),
      ).toBe(true);
    });

    it("normalizes language input and returns detected language with word timestamps", async () => {
      await activatePro();
      vi.mocked(transcribeAudio).mockResolvedValue({
        language: "ja",
        segments: [{ start: 0, end: 1, text: "こんにちは" }],
        words: [
          { start: 0, end: 0.45, word: "こん" },
          { start: 0.45, end: 1, word: "にちは" },
        ],
      });

      const form = new FormData();
      form.append(
        "file",
        new File([createPcmWav(1)], "japanese.wav", {
          type: "audio/wav",
        }),
      );
      form.append("language", " JA ");
      const res = await makeApp().request("/api/v3/ai/transcriptions", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        language: "ja",
        segments: [{ start: 0, end: 1, text: "こんにちは" }],
        words: [
          { start: 0, end: 0.45, word: "こん" },
          { start: 0.45, end: 1, word: "にちは" },
        ],
      });
      expect(vi.mocked(transcribeAudio)).toHaveBeenCalledWith({
        audio: expect.any(ArrayBuffer),
        durationSeconds: 1,
        filename: "japanese.wav",
        mimeType: "audio/wav",
        language: "ja",
        model: "openai/whisper-large-v3-turbo",
        signal: expect.any(AbortSignal),
      });
      expect([...state.aiJobs.values()][0]).toMatchObject({
        inputParams: {
          filename: "japanese.wav",
          durationSeconds: 1,
          language: "ja",
        },
      });
    });

    it("returns 500 aiProviderError and refunds reserved usage when OpenRouter fails", async () => {
      await activatePro();
      vi.mocked(transcribeAudio).mockRejectedValue(
        new AiProviderError("OpenRouter request failed: 500"),
      );

      const form = new FormData();
      form.append("file", new File([createPcmWav(65)], "a.wav", { type: "audio/wav" }));
      const res = await makeApp().request("/api/v3/ai/transcriptions", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({
        error_code: "aiProviderError",
      });
      expect([...state.aiJobs.values()][0]).toMatchObject({
        status: "failed",
        error: "AI transcription failed",
      });
      expect(JSON.stringify([...state.aiJobs.values()][0])).not.toContain(
        "OpenRouter request failed: 500",
      );
      expect(
        state.creditTransactions.some(
          (t) => t.kind === "usage" && t.usageAmount === 10,
        ),
      ).toBe(true);
      expect(
        state.creditTransactions.some(
          (t) => t.kind === "refund" && t.usageAmount === -10,
        ),
      ).toBe(true);
      const account = await getCreditAccount({ userId: USER_ID });
      expect(account.monthlyUsageUsed).toBe(0);
    });
  });

  describe("POST /api/v3/ai/videos", () => {
    it("returns 401 authenticationIsRequired when unauthenticated", async () => {
      const res = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        error_code: "authenticationIsRequired",
      });
    });

    it("returns 402 aiPlanRequired without Pro", async () => {
      const res = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({
        error_code: "aiPlanRequired",
      });
    });

    it("rejects a new reservation after account deletion is authorized", async () => {
      await activatePro();
      state.accountDeletionIntents.set("deletion-intent", {
        identifier: "owner@example.com",
        tokenHash: "token-hash",
        userId: USER_ID,
        stripeCustomerId: null,
        authorizedAt: new Date(),
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });

      const response = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error_code: "doNotHavePermissions",
      });
      expect(state.aiJobs.size).toBe(0);
      expect(vi.mocked(createVideoJob)).not.toHaveBeenCalled();
    });

    it("returns 400 invalidRequestBody for an unsupported duration", async () => {
      await activatePro();
      const res = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 5 }),
      });

      expect(res.status).toBe(400);
      expect(state.aiJobs.size).toBe(0);
      expect(vi.mocked(createVideoJob)).not.toHaveBeenCalled();
    });

    it("rejects an overlong video prompt before reserving usage", async () => {
      await activatePro();

      const response = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({
          prompt: "x".repeat(MAX_AI_PROMPT_LENGTH + 1),
          durationSeconds: 4,
        }),
      });

      expect(response.status).toBe(400);
      expect(state.aiJobs.size).toBe(0);
      expect(vi.mocked(createVideoJob)).not.toHaveBeenCalled();
    });

    it("caps the video JSON body before parsing", async () => {
      await activatePro();

      const response = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({
          prompt: "test",
          durationSeconds: 4,
          padding: "x".repeat(MAX_AI_JSON_REQUEST_BYTES),
        }),
      });

      expect(response.status).toBe(413);
      expect(state.aiJobs.size).toBe(0);
      expect(vi.mocked(createVideoJob)).not.toHaveBeenCalled();
    });

    it("creates a job and reserves 40 usage units per second", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockResolvedValue({
        id: "provider-video-1",
        status: "pending",
      });

      const res = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "  test  ", durationSeconds: 4 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        jobId: expect.any(String),
        status: "running",
      });
      expect(body).not.toHaveProperty("balance");
      expectOperationResponseToHideUsage(body);

      const job = [...state.aiJobs.values()][0];
      expect(job).toMatchObject({
        kind: "video",
        status: "running",
        inputParams: {
          prompt: "test",
          durationSeconds: 4,
          resolution: "720p",
        },
        providerJobId: "provider-video-1",
        usageUnits: 160,
      });
      // Reserve credits when the job is created.
      expect(
        state.creditTransactions.some(
          (t) =>
            t.kind === "usage" &&
            t.usageAmount === 160 &&
            t.aiJobId === job.id,
        ),
      ).toBe(true);
      expect(vi.mocked(createVideoJob)).toHaveBeenCalledOnce();
      const createRequest = vi.mocked(createVideoJob).mock.calls[0][0];
      expect(createRequest).toMatchObject({
        prompt: "test",
        durationSeconds: 4,
        resolution: "720p",
        model: "google/veo-3.1",
        signal: expect.any(AbortSignal),
      });
      expectOpaqueCallbackUrl(createRequest.callbackUrl, job.id);
    });

    it("returns 429 aiJobLimitReached while another job is active", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockResolvedValue({
        id: "provider-video-1",
        status: "pending",
      });

      // Create the first job.
      const first = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });
      expect(first.status).toBe(200);

      // Reject the second job with 429.
      const second = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });
      expect(second.status).toBe(429);
      expect(await second.json()).toMatchObject({
        error_code: "aiJobLimitReached",
      });
    });

    it("does not count a running image job against the video job limit", async () => {
      await activatePro();
      const imageReservation = await createReservedAiJob({
        userId: USER_ID,
        kind: "image",
        provider: "openrouter",
        status: "running",
        usageUnits: 20,
      });
      expect(imageReservation.ok).toBe(true);
      vi.mocked(createVideoJob).mockResolvedValue({
        id: "provider-video-1",
        status: "pending",
      });

      const response = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).not.toHaveProperty("balance");
      expect(state.aiJobs.size).toBe(2);
    });

    it("reserves only one video job for concurrent requests", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockResolvedValue({
        id: "provider-video-1",
        status: "pending",
      });
      const request = async () =>
        await makeApp().request("/api/v3/ai/videos", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(await authHeaders()),
          },
          body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
        });

      const responses = await Promise.all([request(), request()]);

      expect(responses.map((response) => response.status).sort()).toEqual([
        200,
        429,
      ]);
      expect(state.aiJobs.size).toBe(1);
      expect(
        state.creditTransactions.filter(
          (transaction) => transaction.kind === "usage",
        ),
      ).toHaveLength(1);
    });

    it("returns 500 and refunds reserved usage after a definite OpenRouter 4xx", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockRejectedValue(
        new AiVideoSubmissionError("OpenRouter request failed: 400", {
          outcome: "definite_failure",
          httpStatus: 400,
        }),
      );

      const res = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({
        error_code: "aiProviderError",
      });
      expect([...state.aiJobs.values()][0]).toMatchObject({
        status: "failed",
        error: "AI video submission failed",
      });
      expect(JSON.stringify([...state.aiJobs.values()][0])).not.toContain(
        "OpenRouter request failed: 400",
      );

      // Record both reservation and refund, restoring the balance.
      expect(
        state.creditTransactions.some(
          (t) => t.kind === "usage" && t.usageAmount === 160,
        ),
      ).toBe(true);
      expect(
        state.creditTransactions.some(
          (t) => t.kind === "refund" && t.usageAmount === -160,
        ),
      ).toBe(true);
      const account = await getCreditAccount({ userId: USER_ID });
      expect(account.monthlyUsageUsed).toBe(0);
      expect(account.purchasedCredits).toBe(0);
    });

    it("keeps an ambiguous submission pending, pollable, and duplicate-blocking", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockRejectedValue(
        new AiVideoSubmissionError("OpenRouter request timed out", {
          outcome: "unknown",
        }),
      );

      const createResponse = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });
      expect(createResponse.status).toBe(200);
      const createBody = await createResponse.json();
      expect(createBody).toMatchObject({
        jobId: expect.any(String),
        status: "running",
      });
      expect(state.aiJobs.get(createBody.jobId)).toMatchObject({
        status: "queued",
        providerJobId: null,
        usageUnits: 160,
      });
      expect(
        state.creditTransactions.filter(
          (transaction) => transaction.kind === "refund",
        ),
      ).toHaveLength(0);

      const pollResponse = await makeApp().request(
        `/api/v3/ai/videos/${createBody.jobId}`,
        { headers: await authHeaders() },
      );
      expect(pollResponse.status).toBe(200);
      expect(await pollResponse.json()).toMatchObject({
        jobId: createBody.jobId,
        status: "running",
        fileId: null,
        url: null,
      });
      expect(vi.mocked(getVideoJob)).not.toHaveBeenCalled();

      const duplicate = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "duplicate", durationSeconds: 4 }),
      });
      expect(duplicate.status).toBe(429);
      expect(await duplicate.json()).toMatchObject({
        error_code: "aiJobLimitReached",
      });
      expect(vi.mocked(createVideoJob)).toHaveBeenCalledOnce();
    });

    it("queues remote cleanup when account deletion wins during provider submission", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockImplementation(async () => {
        state.accountDeletionIntents.set("deletion-intent", {
          identifier: "owner@example.com",
          tokenHash: "token-hash",
          userId: USER_ID,
          stripeCustomerId: null,
          authorizedAt: new Date(),
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        });
        // Simulate the User cascade committing while the provider request was
        // in flight, after the queued reservation but before attachment.
        state.aiJobs.clear();
        return { id: "provider-video-orphan", status: "pending" };
      });

      const response = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error_code: "aiProviderError",
      });
      expect(
        state.aiRemoteJobCleanups.get(
          "openrouter:provider-video-orphan",
        ),
      ).toMatchObject({
        provider: "openrouter",
        providerJobId: "provider-video-orphan",
        attempts: 0,
      });
      expect(
        state.creditTransactions.filter(
          (transaction) => transaction.kind === "refund",
        ),
      ).toHaveLength(0);
    });

    it("does not enqueue cleanup for a provider job owned by another local job", async () => {
      await activatePro();
      await createAiJob({
        userId: "another-user",
        kind: "video",
        provider: "openrouter",
        status: "queued",
        providerJobId: "provider-collision",
        usageUnits: 1,
      });
      vi.mocked(createVideoJob).mockResolvedValue({
        id: "provider-collision",
        status: "pending",
      });

      const response = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders("provider-collision-request")),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });

      expect(response.status).toBe(500);
      expect(state.aiRemoteJobCleanups.has(
        "openrouter:provider-collision",
      )).toBe(false);
      const current = [...state.aiJobs.values()].find(
        (job) => job.userId === USER_ID,
      );
      expect(current?.status).toBe("failed");
    });

    it("keeps the job pending when attachment ownership cannot be verified", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockResolvedValue({
        id: "provider-verification-unavailable",
        status: "pending",
      });
      const originalUpdateMany = prisma.aiJob.updateMany;
      const originalFindFirst = prisma.aiJob.findFirst;
      const updateSpy = vi.spyOn(prisma.aiJob, "updateMany")
        .mockImplementation(async (args) => {
          if (args.data?.providerJobId === "provider-verification-unavailable") {
            throw new Error("attachment write unavailable");
          }
          return await originalUpdateMany(args);
        });
      const findSpy = vi.spyOn(prisma.aiJob, "findFirst")
        .mockImplementation(async (args) => {
          if (args.where?.providerJobId === "provider-verification-unavailable") {
            throw new Error("attachment read unavailable");
          }
          return await originalFindFirst(args);
        });

      const response = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders("attachment-verification-unavailable")),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });
      updateSpy.mockRestore();
      findSpy.mockRestore();

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "running" });
      expect(state.aiRemoteJobCleanups.size).toBe(0);
      expect([...state.aiJobs.values()][0]).toMatchObject({
        status: "queued",
        providerJobId: null,
      });
      expect(
        state.creditTransactions.filter(
          (transaction) => transaction.kind === "refund",
        ),
      ).toHaveLength(0);
    });
  });

  describe("POST /api/v3/ai/videos/frames", () => {
    it("rejects a missing firstFrame before charging", async () => {
      await activatePro();
      const form = new FormData();
      form.append("prompt", "Animate the scene");
      form.append("durationSeconds", "4");
      form.append("resolution", "720p");

      const res = await makeApp().request("/api/v3/ai/videos/frames", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error_code: "invalidRequestBody",
      });
      expect(state.aiJobs.size).toBe(0);
      expect(state.creditTransactions).toHaveLength(0);
      expect(vi.mocked(createVideoJob)).not.toHaveBeenCalled();
    });

    it("rejects an unsupported lastFrame MIME type before charging", async () => {
      await activatePro();
      const form = new FormData();
      form.append("prompt", "Animate the scene");
      form.append("durationSeconds", "4");
      form.append("resolution", "720p");
      form.append(
        "firstFrame",
        new File([PNG_BYTES], "first.png", {
          type: "image/png",
        }),
      );
      form.append(
        "lastFrame",
        new File([Uint8Array.from([2])], "last.txt", {
          type: "text/plain",
        }),
      );

      const res = await makeApp().request("/api/v3/ai/videos/frames", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });

      expect(res.status).toBe(400);
      expect(state.aiJobs.size).toBe(0);
      expect(state.creditTransactions).toHaveLength(0);
      expect(vi.mocked(createVideoJob)).not.toHaveBeenCalled();
    });

    it.each([
      ["empty image", new Uint8Array(), "empty.png", "image/png"],
      ["disguised SVG", SVG_BYTES, "first.png", "image/png"],
      ["declared MIME mismatch", PNG_BYTES, "first.jpg", "image/jpeg"],
      ["extension mismatch", PNG_BYTES, "first.jpg", "image/png"],
      ["PNG/SVG polyglot", PNG_SVG_POLYGLOT, "first.png", "image/png"],
      ["truncated JPEG", INVALID_GENERATED_JPEG, "first.jpg", "image/jpeg"],
      ["truncated WebP", INVALID_GENERATED_WEBP, "first.webp", "image/webp"],
      ["GIF", GIF_BYTES, "first.gif", "image/gif"],
    ])("rejects %s frame bytes before reserving usage", async (_, bytes, name, type) => {
      await activatePro();
      const form = new FormData();
      form.append("prompt", "Animate the scene");
      form.append("durationSeconds", "4");
      form.append(
        "firstFrame",
        new File([bytes], name, { type }),
      );

      const response = await makeApp().request("/api/v3/ai/videos/frames", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error_code: "invalidRequestBody",
      });
      expect(state.aiJobs.size).toBe(0);
      expect(state.creditTransactions).toHaveLength(0);
      expect(vi.mocked(createVideoJob)).not.toHaveBeenCalled();
    });

    it("returns 413 before charging when Content-Length exceeds the frame upload limit", async () => {
      await activatePro();
      const res = await makeApp().request("/api/v3/ai/videos/frames", {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=test",
          "content-length": String(
            MAX_AI_VIDEO_FRAME_UPLOAD_BYTES * 2 + 64 * 1024 + 1,
          ),
          ...(await authHeaders()),
        },
        body: "--test--",
      });

      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({
        error_code: "fileIsTooLarge",
      });
      expect(state.aiJobs.size).toBe(0);
      expect(state.creditTransactions).toHaveLength(0);
      expect(vi.mocked(createVideoJob)).not.toHaveBeenCalled();
    });

    it("rejects one frame above the reduced base64-safe limit", async () => {
      await activatePro();
      const form = new FormData();
      form.append("prompt", "Animate the scene");
      form.append("durationSeconds", "4");
      form.append(
        "firstFrame",
        new File(
          [new Uint8Array(MAX_AI_VIDEO_FRAME_UPLOAD_BYTES + 1)],
          "first.png",
          { type: "image/png" },
        ),
      );

      const response = await makeApp().request(
        "/api/v3/ai/videos/frames",
        {
          method: "POST",
          headers: await authHeaders(),
          body: form,
        },
      );

      expect(response.status).toBe(413);
      expect(state.aiJobs.size).toBe(0);
      expect(vi.mocked(createVideoJob)).not.toHaveBeenCalled();
    });

    it("rejects an overlong multipart video prompt before reserving usage", async () => {
      await activatePro();
      const form = new FormData();
      form.append("prompt", "x".repeat(MAX_AI_PROMPT_LENGTH + 1));
      form.append("durationSeconds", "4");
      form.append(
        "firstFrame",
        new File([PNG_BYTES], "first.png", { type: "image/png" }),
      );

      const response = await makeApp().request(
        "/api/v3/ai/videos/frames",
        {
          method: "POST",
          headers: await authHeaders(),
          body: form,
        },
      );

      expect(response.status).toBe(400);
      expect(state.aiJobs.size).toBe(0);
      expect(vi.mocked(createVideoJob)).not.toHaveBeenCalled();
    });

    it("submits firstFrame and lastFrame as base64 data URLs", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockResolvedValue({
        id: "provider-video-frames-1",
        status: "pending",
      });

      const form = new FormData();
      form.append("prompt", "  Transition from sunrise to sunset  ");
      form.append("durationSeconds", "6");
      form.append("resolution", "1080p");
      form.append(
        "firstFrame",
        new File([PNG_BYTES], "first.png", {
          type: "image/png",
        }),
      );
      form.append(
        "lastFrame",
        new File([JPEG_BYTES], "last.jpg", {
          type: "image/jpeg",
        }),
      );

      const res = await makeApp().request("/api/v3/ai/videos/frames", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        jobId: expect.any(String),
        status: "running",
      });
      expect(body).not.toHaveProperty("balance");
      expectOperationResponseToHideUsage(body);
      const job = [...state.aiJobs.values()][0];
      expect(vi.mocked(createVideoJob)).toHaveBeenCalledOnce();
      const createRequest = vi.mocked(createVideoJob).mock.calls[0][0];
      expect(createRequest).toMatchObject({
        prompt: "Transition from sunrise to sunset",
        durationSeconds: 6,
        resolution: "1080p",
        frameImages: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`,
            },
            frame_type: "first_frame",
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${Buffer.from(JPEG_BYTES).toString("base64")}`,
            },
            frame_type: "last_frame",
          },
        ],
        model: "google/veo-3.1",
        signal: expect.any(AbortSignal),
      });
      expectOpaqueCallbackUrl(createRequest.callbackUrl, job.id);
      expect(job).toMatchObject({
        kind: "video",
        status: "running",
        providerJobId: "provider-video-frames-1",
        usageUnits: 240,
        inputParams: {
          prompt: "Transition from sunrise to sunset",
          durationSeconds: 6,
          resolution: "1080p",
          firstFrame: {
            filename: "first.png",
            mimeType: "image/png",
          },
          lastFrame: {
            filename: "last.jpg",
            mimeType: "image/jpeg",
          },
        },
      });
    });

    it("allows lastFrame to be omitted and uses the default resolution", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockResolvedValue({
        id: "provider-video-first-frame-1",
        status: "pending",
      });

      const form = new FormData();
      form.append("prompt", "A gentle camera push-in");
      form.append("durationSeconds", "4");
      form.append(
        "firstFrame",
        new File([WEBP_BYTES], "first.webp", {
          type: "image/webp",
        }),
      );
      const res = await makeApp().request("/api/v3/ai/videos/frames", {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });

      expect(res.status).toBe(200);
      const job = [...state.aiJobs.values()][0];
      expect(vi.mocked(createVideoJob)).toHaveBeenCalledOnce();
      const createRequest = vi.mocked(createVideoJob).mock.calls[0][0];
      expect(createRequest).toMatchObject({
        prompt: "A gentle camera push-in",
        durationSeconds: 4,
        resolution: "720p",
        frameImages: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/webp;base64,${Buffer.from(WEBP_BYTES).toString("base64")}`,
            },
            frame_type: "first_frame",
          },
        ],
        model: "google/veo-3.1",
        signal: expect.any(AbortSignal),
      });
      expectOpaqueCallbackUrl(createRequest.callbackUrl, job.id);
    });
  });

  describe("POST /api/v3/ai/videos/:id/openrouter-callback", () => {
    it("attaches from a signed callback that arrives before the submission response", async () => {
      await activatePro();
      vi.mocked(getVideoJob).mockResolvedValue({
        id: "provider-video-callback-race",
        status: "in_progress",
      });
      vi.mocked(createVideoJob).mockImplementation(async ({ callbackUrl }) => {
        const webhookBody = JSON.stringify({
          type: "video.generation.completed",
          created_at: new Date().toISOString(),
          data: {
            id: "provider-video-callback-race",
            status: "completed",
          },
        });
        const parsedCallbackUrl = new URL(callbackUrl);
        const callback = await makeApp().request(
          `${parsedCallbackUrl.pathname}${parsedCallbackUrl.search}`,
          {
            method: "POST",
            headers: signedOpenRouterWebhook(webhookBody),
            body: webhookBody,
          },
        );
        expect(callback.status).toBe(204);
        return { id: "provider-video-callback-race", status: "pending" };
      });

      const response = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        jobId: expect.any(String),
        status: "running",
      });
      expect([...state.aiJobs.values()][0]).toMatchObject({
        status: "running",
        providerJobId: "provider-video-callback-race",
      });
      expect(state.aiRemoteJobCleanups.size).toBe(0);
      expect(vi.mocked(getVideoJob)).toHaveBeenCalledOnce();
    });

    it("recovers a terminal job when the accepted submission response was lost", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockRejectedValue(
        new AiVideoSubmissionError(
          "OpenRouter accepted the request but returned invalid JSON",
          { outcome: "unknown" },
        ),
      );

      const createResponse = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });
      const { jobId } = await createResponse.json();
      const callbackUrl = expectOpaqueCallbackUrl(
        vi.mocked(createVideoJob).mock.calls[0][0].callbackUrl,
        jobId,
      );
      const callbackPath = `${callbackUrl.pathname}${callbackUrl.search}`;
      const webhookBody = JSON.stringify({
        type: "video.generation.completed",
        created_at: new Date().toISOString(),
        data: {
          id: "provider-video-from-callback",
          status: "completed",
          unsigned_urls: ["https://example.com/video.mp4"],
        },
      });
      vi.mocked(getVideoJob).mockImplementation(async (providerJobId) => {
        expect(state.aiJobs.get(jobId)?.providerJobId).toBe(providerJobId);
        return {
          id: providerJobId,
          status: "completed",
          unsignedUrls: ["https://example.com/video.mp4"],
        };
      });
      vi.mocked(downloadVideoContent).mockResolvedValue({
        bytes: new Uint8Array([0, 1, 2, 3]).buffer,
        mimeType: "video/mp4",
        extension: "mp4",
      });

      const invalidSignature = await makeApp().request(callbackPath, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-OpenRouter-Signature":
              `t=${Math.floor(Date.now() / 1_000)},v1=${"0".repeat(64)}`,
          },
          body: webhookBody,
      });
      expect(invalidSignature.status).toBe(401);
      expect(state.aiJobs.get(jobId)).toMatchObject({
        status: "queued",
        providerJobId: null,
      });
      expect(vi.mocked(getVideoJob)).not.toHaveBeenCalled();

      const deliver = async () =>
        await makeApp().request(callbackPath, {
          method: "POST",
          headers: signedOpenRouterWebhook(webhookBody),
          body: webhookBody,
        });
      expect((await deliver()).status).toBe(204);
      expect(state.aiJobs.get(jobId)).toMatchObject({
        status: "succeeded",
        providerJobId: "provider-video-from-callback",
        resultFileId: expect.any(String),
      });
      expect(vi.mocked(getVideoJob)).toHaveBeenCalledOnce();
      expect(vi.mocked(downloadVideoContent)).toHaveBeenCalledOnce();
      expect(
        state.creditTransactions.filter(
          (transaction) => transaction.kind === "refund",
        ),
      ).toHaveLength(0);

      expect((await deliver()).status).toBe(204);
      expect(vi.mocked(getVideoJob)).toHaveBeenCalledOnce();
      expect(vi.mocked(downloadVideoContent)).toHaveBeenCalledOnce();
      expect(state.files.size).toBe(1);
    });

    it("rejects callback recovery when another local job owns the provider ID", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockRejectedValue(
        new AiVideoSubmissionError("Submission outcome unknown", {
          outcome: "unknown",
        }),
      );
      const createResponse = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders("video-callback-conflict")),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });
      const { jobId } = await createResponse.json() as { jobId: string };
      const callbackUrl = new URL(
        vi.mocked(createVideoJob).mock.calls[0][0].callbackUrl,
      );
      const owner = await createAiJob({
        userId: "another-user",
        kind: "video",
        provider: "openrouter",
        providerJobId: "provider-owned-by-another-job",
        status: "running",
        usageUnits: 1,
      });
      const webhookBody = JSON.stringify({
        type: "video.generation.completed",
        created_at: new Date().toISOString(),
        data: {
          id: "provider-owned-by-another-job",
          status: "completed",
        },
      });

      const response = await makeApp().request(
        `${callbackUrl.pathname}${callbackUrl.search}`,
        {
          method: "POST",
          headers: signedOpenRouterWebhook(webhookBody),
          body: webhookBody,
        },
      );

      expect(response.status).toBe(409);
      expect(state.aiJobs.get(jobId)).toMatchObject({
        status: "queued",
        providerJobId: null,
      });
      expect(state.aiJobs.get(owner.id)).toMatchObject({
        status: "running",
        providerJobId: "provider-owned-by-another-job",
      });
      expect(vi.mocked(getVideoJob)).not.toHaveBeenCalled();
    });

    it("rejects a signed callback replayed against another job", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockRejectedValue(
        new AiVideoSubmissionError("Submission outcome unknown", {
          outcome: "unknown",
        }),
      );
      const create = async (key: string, prompt: string) => {
        const response = await makeApp().request("/api/v3/ai/videos", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(await authHeaders(key)),
          },
          body: JSON.stringify({ prompt, durationSeconds: 4 }),
        });
        expect(response.status).toBe(200);
        return await response.json() as { jobId: string };
      };

      const jobA = await create("video-callback-a", "first");
      // The normal one-video limit intentionally prevents a second active job.
      // Mark A terminal without attaching a provider ID, then reserve B.
      state.aiJobs.get(jobA.jobId)!.status = "failed";
      const jobB = await create("video-callback-b", "second");
      const callbackA = new URL(
        vi.mocked(createVideoJob).mock.calls[0][0].callbackUrl,
      );
      const replayPath =
        `/api/v3/ai/videos/${jobB.jobId}/openrouter-callback${callbackA.search}`;
      const webhookBody = JSON.stringify({
        type: "video.generation.completed",
        created_at: new Date().toISOString(),
        data: { id: "provider-replay", status: "completed" },
      });

      const replay = await makeApp().request(replayPath, {
        method: "POST",
        headers: signedOpenRouterWebhook(webhookBody),
        body: webhookBody,
      });

      expect(replay.status).toBe(401);
      expect(state.aiJobs.get(jobB.jobId)).toMatchObject({
        status: "queued",
        providerJobId: null,
      });
      expect(vi.mocked(getVideoJob)).not.toHaveBeenCalled();
    });

    it("rejects a signed body for another provider job on the correct callback URL", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockResolvedValue({
        id: "provider-owned-by-a",
        status: "pending",
      });
      const created = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders("video-cross-body")),
        },
        body: JSON.stringify({ prompt: "first", durationSeconds: 4 }),
      });
      const { jobId } = await created.json() as { jobId: string };
      const callback = new URL(
        vi.mocked(createVideoJob).mock.calls[0][0].callbackUrl,
      );
      const bodyFromB = JSON.stringify({
        type: "video.generation.completed",
        created_at: new Date().toISOString(),
        data: { id: "provider-owned-by-b", status: "completed" },
      });

      const response = await makeApp().request(
        `${callback.pathname}${callback.search}`,
        {
          method: "POST",
          headers: signedOpenRouterWebhook(bodyFromB),
          body: bodyFromB,
        },
      );

      expect(response.status).toBe(409);
      expect(state.aiJobs.get(jobId)?.providerJobId).toBe("provider-owned-by-a");
      expect(vi.mocked(getVideoJob)).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/v3/ai/videos/:id", () => {
    it("returns 404 aiJobNotFound for another user's job", async () => {
      const res = await makeApp().request("/api/v3/ai/videos/unknown", {
        headers: await authHeaders(),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        error_code: "aiJobNotFound",
      });
    });

    it("downloads and stores completed video while retaining reserved usage", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockResolvedValue({
        id: "provider-video-1",
        status: "pending",
      });
      vi.mocked(getVideoJob).mockResolvedValue({
        id: "provider-video-1",
        status: "completed",
        unsignedUrls: ["https://example.com/video.mp4"],
      });
      vi.mocked(downloadVideoContent).mockResolvedValue({
        bytes: new Uint8Array([0, 1, 2, 3]).buffer,
        mimeType: "video/webm",
        extension: "webm",
      });

      const createRes = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });
      const { jobId } = await createRes.json();

      const res = await makeApp().request(`/api/v3/ai/videos/${jobId}`, {
        headers: await authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        jobId,
        status: "succeeded",
        fileId: expect.any(String),
        url: `https://beutl.beditor.net/api/contents/${body.fileId}`,
        fileName: `ai-video-${jobId}.webm`,
        contentType: "video/webm",
      });
      expect(body).not.toHaveProperty("balance");
      expectOperationResponseToHideUsage(body);

      const job = [...state.aiJobs.values()][0];
      expect(job).toMatchObject({
        status: "succeeded",
        resultFileId: body.fileId,
      });
      expect(state.files.size).toBe(1);
      expect([...state.files.values()][0]).toMatchObject({
        name: `ai-video-${jobId}.webm`,
        mimeType: "video/webm",
      });
      expect(
        state.creditTransactions.some(
          (t) =>
            t.kind === "usage" &&
            t.usageAmount === 160 &&
            t.aiJobId === job.id,
        ),
      ).toBe(true);

      const retry = await makeApp().request(`/api/v3/ai/videos/${jobId}`, {
        headers: await authHeaders(),
      });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual(body);
      expect(vi.mocked(getVideoJob)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(downloadVideoContent)).toHaveBeenCalledOnce();
      expect(vi.mocked(downloadVideoContent)).toHaveBeenCalledWith(
        "provider-video-1",
      );
      expect(state.files.size).toBe(1);
    });

    it("returns running while the provider job is active", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockResolvedValue({
        id: "provider-video-1",
        status: "pending",
      });
      vi.mocked(getVideoJob).mockResolvedValue({
        id: "provider-video-1",
        status: "in_progress",
      });

      const createRes = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });
      const { jobId } = await createRes.json();

      const res = await makeApp().request(`/api/v3/ai/videos/${jobId}`, {
        headers: await authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        jobId,
        status: "running",
        fileId: null,
        url: null,
        fileName: null,
        contentType: null,
      });
      expect(body).not.toHaveProperty("balance");
    });

    it("atomically leases provider polling across parallel GET requests", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockResolvedValue({
        id: "provider-video-parallel-poll",
        status: "pending",
      });
      let finishProviderPoll!: () => void;
      vi.mocked(getVideoJob).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishProviderPoll = () => resolve({
              id: "provider-video-parallel-poll",
              status: "in_progress",
            });
          }),
      );

      const createResponse = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });
      const { jobId } = await createResponse.json();
      const requestStatus = async () =>
        await makeApp().request(`/api/v3/ai/videos/${jobId}`, {
          headers: await authHeaders(),
        });

      const firstPoll = requestStatus();
      await vi.waitFor(() =>
        expect(vi.mocked(getVideoJob)).toHaveBeenCalledOnce(),
      );
      const secondPoll = await requestStatus();

      expect(secondPoll.status).toBe(200);
      expect(await secondPoll.json()).toMatchObject({
        jobId,
        status: "running",
      });
      expect(vi.mocked(getVideoJob)).toHaveBeenCalledOnce();

      finishProviderPoll();
      expect((await firstPoll).status).toBe(200);
      expect(vi.mocked(getVideoJob)).toHaveBeenCalledOnce();
    });

    it("refunds usage and returns the updated balance after provider failure", async () => {
      await activatePro();
      vi.mocked(createVideoJob).mockResolvedValue({
        id: "provider-video-1",
        status: "pending",
      });
      vi.mocked(getVideoJob).mockResolvedValue({
        id: "provider-video-1",
        status: "failed",
        error: "private provider detail: generation failed",
      });

      const createRes = await makeApp().request("/api/v3/ai/videos", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({ prompt: "test", durationSeconds: 4 }),
      });
      const { jobId } = await createRes.json();

      const res = await makeApp().request(`/api/v3/ai/videos/${jobId}`, {
        headers: await authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        jobId,
        status: "failed",
        fileId: null,
        url: null,
        fileName: null,
        contentType: null,
        error: "aiProviderError",
      });
      expect(body).not.toHaveProperty("balance");
      expectOperationResponseToHideUsage(body);
      expect(
        state.creditTransactions.filter(
          (transaction) => transaction.kind === "refund",
        ),
      ).toHaveLength(1);
      expect(state.aiJobs.get(jobId)).toMatchObject({
        error: "AI video generation failed",
      });
      expect(JSON.stringify(state.aiJobs.get(jobId))).not.toContain(
        "private provider detail",
      );

      const retry = await makeApp().request(`/api/v3/ai/videos/${jobId}`, {
        headers: await authHeaders(),
      });
      expect(retry.status).toBe(200);
      const retryBody = await retry.json();
      expect(retryBody).toMatchObject({
        jobId,
        status: "failed",
      });
      expect(retryBody).not.toHaveProperty("balance");
      expect(
        state.creditTransactions.filter(
          (transaction) => transaction.kind === "refund",
        ),
      ).toHaveLength(1);
    });
  });

  describe("streaming multipart upload limits", () => {
    it("accepts a legitimate chunked upload without Content-Length", async () => {
      await activatePro();
      vi.mocked(transcribeAudio).mockResolvedValue({
        segments: [{ start: 0, end: 1, text: "Hello" }],
      });
      const form = new FormData();
      form.append(
        "file",
        new File([createPcmWav(1)], "chunked.wav", { type: "audio/wav" }),
      );

      const response = await requestChunkedForm(
        "/api/v3/ai/transcriptions",
        form,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        segments: expect.any(Array),
      });
      expect(vi.mocked(transcribeAudio)).toHaveBeenCalledOnce();
    });

    it.each([
      ["image edit", "/api/v3/ai/images/edit", MAX_AI_IMAGE_UPLOAD_BYTES],
      [
        "transcription",
        "/api/v3/ai/transcriptions",
        MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
      ],
      [
        "video frames",
        "/api/v3/ai/videos/frames",
        MAX_AI_VIDEO_FRAME_UPLOAD_BYTES * 2,
      ],
    ] as const)(
      "stops an oversized chunked %s body at the stream limit",
      async (_, path, maximumBytes) => {
        await activatePro();

        const result = await requestOversizedChunkedBody({
          path,
          maximumBytes,
        });

        expect(result.response.status).toBe(413);
        expect(await result.response.json()).toMatchObject({
          error_code: "fileIsTooLarge",
        });
        expect(result.chunksRead).toBeLessThanOrEqual(
          result.maximumExpectedChunks,
        );
        expect(result.cancelled).toBe(true);
        expect(state.aiJobs.size).toBe(0);
      },
    );

    it("does not trust a forged small Content-Length", async () => {
      await activatePro();

      const result = await requestOversizedChunkedBody({
        path: "/api/v3/ai/transcriptions",
        maximumBytes: MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
        forgedContentLength: "1",
      });

      expect(result.response.status).toBe(413);
      expect(result.chunksRead).toBeLessThanOrEqual(
        result.maximumExpectedChunks,
      );
      expect(result.cancelled).toBe(true);
      expect(state.aiJobs.size).toBe(0);
    });
  });
});
