import { beforeEach, describe, expect, it } from "vitest";
import { AI_TEXT_RESULT_RETENTION_MILLISECONDS } from "@beutl/core";
import { createAiJob, setDbProvider } from "@beutl/db";
import { aiJobStateForIdempotencyKey } from "@beutl/api";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

describe("AI idempotency recovery deadline", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
  });

  async function succeededJob({
    now,
    completedAt,
    updatedAt,
  }: {
    now: Date;
    completedAt: Date;
    updatedAt: Date;
  }) {
    const job = await createAiJob({
      userId: "u",
      kind: "video",
      provider: "vercel-gateway",
      status: "succeeded",
      usageUnits: 1,
      idempotencyKeyHash: "key-hash",
      requestFingerprint: "fingerprint",
    });
    memory.state.files.set("result", {
      id: "result",
      userId: "u",
      objectKey: "ai/video/result",
      name: "result.mp4",
      size: 1,
      mimeType: "video/mp4",
      visibility: "PRIVATE",
      sha256: null,
      createdAt: completedAt,
      updatedAt: completedAt,
    });
    Object.assign(memory.state.aiJobs.get(job.id)!, {
      createdAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000),
      updatedAt,
      resultFileId: "result",
    });
    return await aiJobStateForIdempotencyKey({
      userId: "u",
      idempotencyKeyHash: "key-hash",
      now,
    });
  }

  it("does not extend paid upload recovery when a cost retry rotates updatedAt", async () => {
    const now = new Date("2026-09-24T00:00:00.000Z");
    const completedAt = new Date(now.getTime() - AI_TEXT_RESULT_RETENTION_MILLISECONDS - 1);
    const updatedAt = new Date(now.getTime() + 23 * 60 * 60 * 1000);

    expect(await succeededJob({ now, completedAt, updatedAt })).toBe("settled");
  });

  it("keeps a recently completed result recoverable despite unrelated job timestamps", async () => {
    const now = new Date("2026-09-24T00:00:00.000Z");
    const completedAt = new Date(now.getTime() - AI_TEXT_RESULT_RETENTION_MILLISECONDS + 1);
    const updatedAt = new Date(now.getTime() - AI_TEXT_RESULT_RETENTION_MILLISECONDS - 1);

    expect(await succeededJob({ now, completedAt, updatedAt })).toBe("collectable");
  });
});
