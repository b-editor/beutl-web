import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { setDbProvider } from "@beutl/db";
import { v3 } from "@beutl/api";
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

describe("working from a video this service already holds", () => {
  let state: ReturnType<typeof createInMemoryPrisma>["state"];

  beforeEach(() => {
    vi.clearAllMocks();
    const memory = createInMemoryPrisma();
    state = memory.state;
    setDbProvider(async () => memory.prisma as never);
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.PUBLIC_ORIGIN = "https://beutl.beditor.net";
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.PUBLIC_ORIGIN;
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

    expect(response.status).toBe(404);
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

    expect(response.status).toBe(404);
    expect(createAndAttachVideoJob).not.toHaveBeenCalled();
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
