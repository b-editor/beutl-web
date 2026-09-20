import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { setDbProvider, upsertSubscription } from "@beutl/db";
import { AiVideoSubmissionError, v3 } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

// Nothing here should reach a provider: every case is refused before the usage
// is reserved. Spying on the submission is how that is checked.
const createAndAttachVideoJob = vi.hoisted(() => vi.fn());
vi.mock("../../packages/api/src/ai/video-jobs", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../packages/api/src/ai/video-jobs")
  >();
  return { ...actual, createAndAttachVideoJob };
});

// Container parsing is covered by ai-video-validation.test.ts; these cases
// exercise request admission and ambiguous provider outcomes.
vi.mock("../../packages/api/src/ai/video-validation", async (original) => ({
  ...(await original<typeof import("../../packages/api/src/ai/video-validation")>()),
  inspectGeneratedVideo: vi.fn(() => ({ mimeType: "video/mp4", durationSeconds: 6 })),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const JWT_SECRET = "test-secret-for-source-video-modes";
const SOURCE_JOB_ID = "22222222-2222-4222-8222-222222222222";

function makeApp() {
  return new Hono().basePath("/api/v3").route("/", v3);
}

async function authHeaders() {
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
    "Idempotency-Key": crypto.randomUUID(),
    "content-type": "application/json",
  };
}

/** A one-pixel PNG: the smallest thing the character field accepts. */
const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const PERIOD_START = new Date(Date.now() - 24 * 60 * 60 * 1000);
const PERIOD_END = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

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

/** The stored result the source job points at. Without it the job reads as
 * having produced no video, and the request is refused before it is reserved. */
function sourceVideoFile() {
  return {
    id: "file-1",
    userId: USER_ID,
    objectKey: `ai/video/${SOURCE_JOB_ID}/object`,
    name: "source.mp4",
    size: 1024,
    mimeType: "video/mp4",
    visibility: "PRIVATE",
    sha256: "abc",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never;
}

/** A finished six-second video of this user's, which the modes work from. */
function sourceVideoJob() {
  return {
    id: SOURCE_JOB_ID,
    userId: USER_ID,
    kind: "video",
    provider: "vercel-gateway",
    status: "succeeded",
    resultFileId: "file-1",
    usageUnits: 40,
    inputParams: { durationSeconds: 6 },
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never;
}

describe("uploaded video sources and rejection of removed job references", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];

  beforeEach(() => {
    vi.clearAllMocks();
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.PUBLIC_ORIGIN = "https://beutl.beditor.net";
    // These three modes exist on Vercel AI Gateway alone, and their built-in
    // entry is withheld from a deployment that cannot call it.
    process.env.VERCEL_AI_GATEWAY_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.PUBLIC_ORIGIN;
    delete process.env.VERCEL_AI_GATEWAY_API_KEY;
  });

  const post = async (path: string, body: Record<string, unknown>) =>
    await makeApp().request(`/api/v3/ai/videos/${path}`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(body),
    });

  it("refuses an edit that names a length, because the source decides it", async () => {
    // The result is as long as what it was given. Accepting a length here
    // would charge for a number nothing honours.
    const response = await post("edit", {
      prompt: "make it night",
      sourceJobId: SOURCE_JOB_ID,
      durationSeconds: 4,
    });

    expect(response.status).toBe(400);
    expect(createAndAttachVideoJob).not.toHaveBeenCalled();
  });

  it("refuses an extension that names no length", async () => {
    // Unlike an edit, the added segment's length is the caller's to choose and
    // is what the request is charged for.
    const response = await post("extend", {
      prompt: "keep going",
      sourceJobId: SOURCE_JOB_ID,
    });

    expect(response.status).toBe(400);
    expect(createAndAttachVideoJob).not.toHaveBeenCalled();
  });

  it("refuses a source nobody here owns, before anything is reserved", async () => {
    // The job id is the caller's whole claim to the video. Checking it after
    // the reservation would charge for a request that can never run.
    const response = await post("extend", {
      prompt: "keep going",
      sourceJobId: SOURCE_JOB_ID,
      durationSeconds: 4,
    });

    expect(response.status).toBe(400);
    expect(state.aiJobs.size).toBe(0);
    expect(createAndAttachVideoJob).not.toHaveBeenCalled();
  });

  it("refuses a source that belongs to someone else", async () => {
    state.aiJobs.set(SOURCE_JOB_ID, {
      id: SOURCE_JOB_ID,
      userId: "99999999-9999-4999-8999-999999999999",
      kind: "video",
      provider: "vercel-gateway",
      status: "succeeded",
      resultFileId: "file-1",
      usageUnits: 40,
      inputParams: { durationSeconds: 6 },
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const response = await post("edit", {
      prompt: "make it night",
      sourceJobId: SOURCE_JOB_ID,
    });

    expect(response.status).toBe(400);
    expect(createAndAttachVideoJob).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous edit queued instead of reporting a failure", async () => {
    // When the provider may have taken the job and only its answer was lost,
    // reporting a failure has the client drop the idempotency key and start a
    // second paid generation once the slot clears — while the first is still
    // queued and may yet arrive by callback. The generation routes return the
    // queued job for this; these three used to return 500.
    await activatePro();
    state.aiJobs.set(SOURCE_JOB_ID, sourceVideoJob());
    state.files.set("file-1", sourceVideoFile());
    createAndAttachVideoJob.mockRejectedValue(
      new AiVideoSubmissionError("Vercel AI Gateway request timed out", {
        outcome: "unknown",
      }),
    );

    const form = new FormData();
    form.set("prompt", "make it night");
    form.set("sourceVideo", new File(["clip"], "clip.mp4", { type: "video/mp4" }));
    const { "content-type": _contentType, ...headers } = await authHeaders();
    const response = await makeApp().request("/api/v3/ai/videos/edit", { method: "POST", headers, body: form });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ jobId: expect.any(String), status: "running" });
    expect(state.aiJobs.get(body.jobId)).toMatchObject({
      status: "queued",
      providerJobId: null,
    });
    // Nothing was given back: the job is still the user's, and refunding it
    // here would pay for a result that may still arrive.
    expect(
      state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(0);
    expect(createAndAttachVideoJob).toHaveBeenCalledOnce();
  });

  it("keeps an ambiguous motion job queued as well", async () => {
    // The motion route carried its own copy of the same branch.
    await activatePro();
    state.aiJobs.set(SOURCE_JOB_ID, sourceVideoJob());
    state.files.set("file-1", sourceVideoFile());
    createAndAttachVideoJob.mockRejectedValue(
      new AiVideoSubmissionError("Vercel AI Gateway request timed out", {
        outcome: "unknown",
      }),
    );

    const form = new FormData();
    form.set("prompt", "dance");
    form.set("sourceVideo", new File(["clip"], "clip.mp4", { type: "video/mp4" }));
    form.set("durationSeconds", "5");
    form.set(
      "characterImage",
      new File([PNG_BYTES], "character.png", { type: "image/png" }),
    );
    const { "content-type": _contentType, ...headers } = await authHeaders();
    const response = await makeApp().request("/api/v3/ai/videos/motion", {
      method: "POST",
      headers,
      body: form,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ jobId: expect.any(String), status: "running" });
    expect(state.aiJobs.get(body.jobId)).toMatchObject({ status: "queued" });
    expect(
      state.creditTransactions.filter((item) => item.kind === "refund"),
    ).toHaveLength(0);
  });

  it("refuses a body it does not recognise", async () => {
    const response = await post("extend", {
      prompt: "keep going",
      sourceJobId: "not-a-uuid",
      durationSeconds: 4,
    });

    expect(response.status).toBe(400);
    expect(createAndAttachVideoJob).not.toHaveBeenCalled();
  });
});
