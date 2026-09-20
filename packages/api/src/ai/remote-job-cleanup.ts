import {
  claimAiRemoteJobCleanup,
  completeAiRemoteJobCleanup,
  getAiJobByProviderJobId,
  listDueAiRemoteJobCleanups,
  rescheduleAiRemoteJobCleanup,
} from "@beutl/db";
import { AiProviderError } from "./openrouter";
import { videoProviderFor } from "./providers/registry";
import type { AiVideoJobInfo } from "./providers/types";

const REMOTE_JOB_LEASE_MS = 30_000;
const REMOTE_JOB_POLL_DELAY_MS = 5 * 60 * 1_000;
const MAX_REMOTE_JOB_ERROR_DELAY_MS = 60 * 60 * 1_000;
const TERMINAL_VIDEO_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

function isMissingRemoteJob(error: unknown): boolean {
  return error instanceof AiProviderError && error.httpStatus === 404;
}

export async function reconcileDeletedAccountRemoteJobs(now = new Date()) {
  const due = await listDueAiRemoteJobCleanups({ now });
  const result = { inspected: due.length, completed: 0, pending: 0, errors: 0 };
  for (const candidate of due) {
    const leaseExpiresAt = new Date(now.getTime() + REMOTE_JOB_LEASE_MS);
    const cleanup = await claimAiRemoteJobCleanup({
      provider: candidate.provider,
      providerJobId: candidate.providerJobId,
      now,
      leaseExpiresAt,
    });
    if (!cleanup) continue;
    try {
      // Throws for a provider with no implementation, which lands in the retry
      // branch below rather than losing the row.
      const videoProvider = videoProviderFor(cleanup.provider);
      // A cleanup intent can race with a successful local attachment. Never
      // poll or retire a provider job while a live AiJob owns its identifier.
      const localOwner = await getAiJobByProviderJobId({
        provider: cleanup.provider,
        providerJobId: cleanup.providerJobId,
      });
      if (localOwner) {
        await completeAiRemoteJobCleanup({
          provider: cleanup.provider,
          providerJobId: cleanup.providerJobId,
          leaseExpiresAt,
        });
        result.completed++;
        continue;
      }
      let remoteJob: AiVideoJobInfo | null;
      try {
        remoteJob = await videoProvider.status({
          providerJobId: cleanup.providerJobId,
          model: cleanup.model,
        });
      } catch (error) {
        if (!isMissingRemoteJob(error)) throw error;
        remoteJob = null;
      }
      if (
        remoteJob === null ||
        TERMINAL_VIDEO_STATUSES.has(remoteJob.status)
      ) {
        await completeAiRemoteJobCleanup({
          provider: cleanup.provider,
          providerJobId: cleanup.providerJobId,
          leaseExpiresAt,
        });
        result.completed++;
      } else {
        await rescheduleAiRemoteJobCleanup({
          provider: cleanup.provider,
          providerJobId: cleanup.providerJobId,
          leaseExpiresAt,
          notBefore: new Date(now.getTime() + REMOTE_JOB_POLL_DELAY_MS),
          lastError: null,
        });
        result.pending++;
      }
    } catch (error) {
      const delay = Math.min(
        REMOTE_JOB_POLL_DELAY_MS * 2 ** Math.min(cleanup.attempts, 4),
        MAX_REMOTE_JOB_ERROR_DELAY_MS,
      );
      await rescheduleAiRemoteJobCleanup({
        provider: cleanup.provider,
        providerJobId: cleanup.providerJobId,
        leaseExpiresAt,
        notBefore: new Date(now.getTime() + delay),
        lastError: error instanceof Error ? error.message : String(error),
      });
      result.errors++;
    }
  }
  return result;
}
