import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimAiRemoteJobCleanup: vi.fn(),
  completeAiRemoteJobCleanup: vi.fn(),
  getAiJobByProviderJobId: vi.fn(),
  getVideoJob: vi.fn(),
  listDueAiRemoteJobCleanups: vi.fn(),
  rescheduleAiRemoteJobCleanup: vi.fn(),
}));

vi.mock("@beutl/db", () => ({
  claimAiRemoteJobCleanup: mocks.claimAiRemoteJobCleanup,
  completeAiRemoteJobCleanup: mocks.completeAiRemoteJobCleanup,
  getAiJobByProviderJobId: mocks.getAiJobByProviderJobId,
  listDueAiRemoteJobCleanups: mocks.listDueAiRemoteJobCleanups,
  rescheduleAiRemoteJobCleanup: mocks.rescheduleAiRemoteJobCleanup,
}));
vi.mock("../../packages/api/src/ai/openrouter-video", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../packages/api/src/ai/openrouter-video")
  >();
  return { ...original, getVideoJob: mocks.getVideoJob };
});

import { AiProviderError } from "../../packages/api/src/ai/openrouter";
import { reconcileDeletedAccountRemoteJobs } from "../../packages/api/src/ai/remote-job-cleanup";

describe("deleted-account remote AI cleanup", () => {
  const now = new Date("2026-08-11T00:00:00.000Z");
  const cleanup = {
    provider: "openrouter",
    providerJobId: "provider-video-1",
    attempts: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listDueAiRemoteJobCleanups.mockResolvedValue([cleanup]);
    mocks.claimAiRemoteJobCleanup.mockResolvedValue(cleanup);
    mocks.getAiJobByProviderJobId.mockResolvedValue(null);
  });

  it("retains a pending remote job without downloading its output", async () => {
    mocks.getVideoJob.mockResolvedValue({
      id: cleanup.providerJobId,
      status: "in_progress",
    });

    await expect(reconcileDeletedAccountRemoteJobs(now)).resolves.toEqual({
      inspected: 1,
      completed: 0,
      pending: 1,
      errors: 0,
    });
    expect(mocks.rescheduleAiRemoteJobCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        providerJobId: cleanup.providerJobId,
        lastError: null,
      }),
    );
    expect(mocks.completeAiRemoteJobCleanup).not.toHaveBeenCalled();
  });

  it("removes the outbox row once the provider job is terminal", async () => {
    mocks.getVideoJob.mockResolvedValue({
      id: cleanup.providerJobId,
      status: "completed",
    });

    await expect(reconcileDeletedAccountRemoteJobs(now)).resolves.toEqual({
      inspected: 1,
      completed: 1,
      pending: 0,
      errors: 0,
    });
    expect(mocks.completeAiRemoteJobCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ providerJobId: cleanup.providerJobId }),
    );
  });

  it("removes the outbox row when the provider reports the job is gone", async () => {
    mocks.getVideoJob.mockRejectedValue(
      new AiProviderError("OpenRouter request failed: 404 Not Found", {
        httpStatus: 404,
      }),
    );

    await expect(reconcileDeletedAccountRemoteJobs(now)).resolves.toEqual({
      inspected: 1,
      completed: 1,
      pending: 0,
      errors: 0,
    });
    expect(mocks.completeAiRemoteJobCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ providerJobId: cleanup.providerJobId }),
    );
    expect(mocks.rescheduleAiRemoteJobCleanup).not.toHaveBeenCalled();
  });
});
