import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { setDbProvider } from "@beutl/db";
import { v3 } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";
import { createCallbackNonce } from "../../packages/api/src/ai/request-integrity";

// The route re-reads the job from the provider rather than believing the
// delivery, so the poll is what has to be observed.
const getGatewayVideoJob = vi.hoisted(() => vi.fn());
const downloadGatewayVideoContent = vi.hoisted(() => vi.fn());
vi.mock(
  "../../packages/api/src/ai/providers/vercel-gateway/video",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../../packages/api/src/ai/providers/vercel-gateway/video")
    >();
    return { ...actual, getGatewayVideoJob, downloadGatewayVideoContent };
  },
);

const USER_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_JOB_ID = "job_01M0BR9PFAW07NGK9813RGPJJ2";

function makeApp() {
  return new Hono().basePath("/api/v3").route("/", v3);
}

function delivery(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "video.generation.completed",
    data: {
      jobId: PROVIDER_JOB_ID,
      modelId: "google/veo-3.1-generate-001",
      status: "completed",
      ...overrides,
    },
  });
}

describe("POST /api/v3/ai/videos/:id/gateway-callback", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];
  let nonce: Awaited<ReturnType<typeof createCallbackNonce>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
    process.env.PUBLIC_ORIGIN = "https://beutl.beditor.net";
    getGatewayVideoJob.mockResolvedValue({
      id: PROVIDER_JOB_ID,
      status: "pending",
      error: null,
    });

    nonce = await createCallbackNonce();
    state.aiJobs.set(JOB_ID, {
      id: JOB_ID,
      userId: USER_ID,
      kind: "video",
      provider: "vercel-gateway",
      providerJobId: PROVIDER_JOB_ID,
      model: "google/veo-3.1-generate-001",
      idempotencyKeyHash: null,
      requestFingerprint: null,
      callbackNonceHash: nonce.hash,
      // The state a job is in once the provider has accepted it, which is when
      // a terminal delivery can arrive.
      status: "running",
      inputParams: null,
      resultFileId: null,
      usageUnits: 40,
      error: null,
      providerPollLeaseExpiresAt: null,
      finalizationToken: null,
      finalizationLeaseExpiresAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
  });

  afterEach(() => {
    delete process.env.PUBLIC_ORIGIN;
  });

  const post = (query: string, body = delivery()) =>
    makeApp().request(`/api/v3/ai/videos/${JOB_ID}/gateway-callback${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  it("reads the job from the provider instead of believing the delivery", async () => {
    // The payload says "completed". Nothing acts on that: the outcome comes
    // from the poll, which here still reports the job as running.
    const response = await post(`?nonce=${nonce.nonce}`);

    expect(response.status).toBe(204);
    expect(getGatewayVideoJob).toHaveBeenCalledWith({
      providerJobId: PROVIDER_JOB_ID,
      model: "google/veo-3.1-generate-001",
    });
    expect(state.aiJobs.get(JOB_ID)?.status).not.toBe("succeeded");
  });

  it("refuses a delivery that cannot present the job's nonce", async () => {
    // The nonce is the whole of the authentication here. Without this check the
    // endpoint would let anyone who can guess a job id spend its poll lease.
    expect((await post("")).status).toBe(401);
    expect((await post("?nonce=")).status).toBe(401);
    expect((await post("?nonce=not-the-nonce")).status).toBe(401);
    expect(getGatewayVideoJob).not.toHaveBeenCalled();
  });

  it("refuses a job that belongs to another provider", async () => {
    // OpenRouter's jobs are finished on OpenRouter's route, which verifies a
    // signature this one does not have.
    state.aiJobs.set(JOB_ID, {
      ...state.aiJobs.get(JOB_ID)!,
      provider: "openrouter",
    } as never);

    expect((await post(`?nonce=${nonce.nonce}`)).status).toBe(401);
    expect(getGatewayVideoJob).not.toHaveBeenCalled();
  });

  it("refuses a delivery naming a different remote job", async () => {
    const response = await post(
      `?nonce=${nonce.nonce}`,
      delivery({ jobId: "job_someone_elses" }),
    );

    expect(response.status).toBe(409);
    expect(getGatewayVideoJob).not.toHaveBeenCalled();
  });

  it("refuses a body whose type and status disagree", async () => {
    // A delivery claiming completion while reporting a failure is malformed,
    // and acting on either half would be a guess.
    const response = await post(
      `?nonce=${nonce.nonce}`,
      JSON.stringify({
        type: "video.generation.completed",
        data: { jobId: PROVIDER_JOB_ID, status: "failed" },
      }),
    );

    expect(response.status).toBe(400);
    expect(getGatewayVideoJob).not.toHaveBeenCalled();
  });

  it("does nothing for a job that has already finished", async () => {
    // Deliveries are retried with the same idempotency key; a repeat must not
    // re-poll a settled job.
    state.aiJobs.set(JOB_ID, {
      ...state.aiJobs.get(JOB_ID)!,
      status: "succeeded",
    } as never);

    expect((await post(`?nonce=${nonce.nonce}`)).status).toBe(204);
    expect(getGatewayVideoJob).not.toHaveBeenCalled();
  });
});
