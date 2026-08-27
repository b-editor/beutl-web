import { Prisma } from "@prisma/client";
import { getDb } from "./provider";
import {
  startRetryableTransaction,
  startTransaction,
  type PrismaTransaction,
} from "./transaction";
import { STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS } from "./storage-multipart-cleanup";

const ACTIVE_AI_JOB_STATUSES = ["queued", "running", "finalizing"];
const MAX_AI_JOB_HISTORY_PAGE_SIZE = 100;
const AI_JOB_RESULT_FILE_SELECT = {
  name: true,
  mimeType: true,
} as const;

export class StorageCleanupBusyError extends Error {
  readonly objectKeys: string[];

  constructor(objectKeys: string[]) {
    super("Storage cleanup is currently leased by another operation");
    this.name = "StorageCleanupBusyError";
    this.objectKeys = objectKeys;
  }
}

async function findStorageCleanupForMutation(
  tx: PrismaTransaction,
  objectKey: string,
  now: Date,
) {
  const row = await tx.aiStorageCleanup.findFirst({
    where: { objectKey },
    select: { objectKey: true, leaseToken: true, notBefore: true },
  });
  // A lease token means a cleaner owns the remote side effect, even after its
  // deadline. Only the cleanup claimant may replace an expired token; writers
  // must wait for that claimant to finish or they could publish a new object
  // while the old cleaner is still deleting the same key.
  if (row?.leaseToken) {
    throw new StorageCleanupBusyError([objectKey]);
  }
  return row;
}

export type AiJobHistoryCursor = {
  createdAt: Date;
  id: string;
};

export function isActiveAiJobStatus(status: string): boolean {
  return ACTIVE_AI_JOB_STATUSES.includes(status);
}

export async function createAiJob({
  userId,
  kind,
  provider,
  providerJobId,
  idempotencyKeyHash,
  requestFingerprint,
  callbackNonceHash,
  status,
  inputParams,
  usageUnits,
  model,
  prisma,
}: {
  userId: string;
  kind: string;
  provider: string;
  providerJobId?: string;
  idempotencyKeyHash?: string;
  requestFingerprint?: string;
  callbackNonceHash?: string;
  status: string;
  inputParams?: object;
  usageUnits: number;
  model?: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.aiJob.create({
    data: {
      userId,
      kind,
      provider,
      providerJobId,
      idempotencyKeyHash,
      requestFingerprint,
      callbackNonceHash,
      status,
      inputParams: inputParams ?? undefined,
      usageUnits,
      model,
    },
  });
}

export async function getAiJobByIdempotency({
  userId,
  idempotencyKeyHash,
  prisma,
}: {
  userId: string;
  idempotencyKeyHash: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.aiJob.findFirst({
    where: {
      userId,
      idempotencyKeyHash,
    },
    include: {
      resultFile: { select: AI_JOB_RESULT_FILE_SELECT },
    },
  });
}

export async function updateActiveAiJobToFailed({
  jobId,
  error,
  now = new Date(),
  expectedProviderJobId,
  prisma,
}: {
  jobId: string;
  error: string;
  now?: Date;
  expectedProviderJobId?: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const result = await db.aiJob.updateMany({
    where: {
      id: jobId,
      deletedAt: null,
      ...(expectedProviderJobId === undefined
        ? {}
        : { providerJobId: expectedProviderJobId }),
      AND: [
        {
          OR: [
            { providerPollLeaseExpiresAt: null },
            { providerPollLeaseExpiresAt: { lte: now } },
          ],
        },
        {
          OR: [
            { status: { in: ["queued", "running"] } },
            {
              status: "finalizing",
              OR: [
                { finalizationToken: null },
                { finalizationLeaseExpiresAt: null },
                { finalizationLeaseExpiresAt: { lte: now } },
              ],
            },
          ],
        },
      ],
    },
    data: {
      status: "failed",
      error,
      providerPollLeaseExpiresAt: null,
      finalizationToken: null,
      finalizationLeaseExpiresAt: null,
    },
  });
  return result.count === 1;
}

export async function failAiJobOwnedByFinalizer({
  jobId,
  finalizationToken,
  expectedProviderJobId,
  error,
  prisma,
}: {
  jobId: string;
  finalizationToken: string;
  expectedProviderJobId: string;
  error: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const result = await db.aiJob.updateMany({
    where: {
      id: jobId,
      status: "finalizing",
      finalizationToken,
      providerJobId: expectedProviderJobId,
      deletedAt: null,
    },
    data: {
      status: "failed",
      error,
      providerPollLeaseExpiresAt: null,
      finalizationToken: null,
      finalizationLeaseExpiresAt: null,
    },
  });
  return result.count === 1;
}

export async function failAiJobOwnedByProviderPoll({
  jobId,
  providerPollLeaseExpiresAt,
  expectedProviderJobId,
  error,
  prisma,
}: {
  jobId: string;
  providerPollLeaseExpiresAt: Date;
  expectedProviderJobId: string;
  error: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const result = await db.aiJob.updateMany({
    where: {
      id: jobId,
      status: { in: ["queued", "running"] },
      providerJobId: expectedProviderJobId,
      providerPollLeaseExpiresAt,
      deletedAt: null,
    },
    data: {
      status: "failed",
      error,
      providerPollLeaseExpiresAt: null,
      finalizationToken: null,
      finalizationLeaseExpiresAt: null,
    },
  });
  return result.count === 1;
}

export async function setQueuedAiJobRunning({
  jobId,
  providerJobId,
  prisma,
}: {
  jobId: string;
  providerJobId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const result = await db.aiJob.updateMany({
    where: {
      id: jobId,
      status: "queued",
    },
    data: {
      status: "running",
      providerJobId,
      error: null,
      providerPollLeaseExpiresAt: null,
      finalizationToken: null,
      finalizationLeaseExpiresAt: null,
    },
  });
  return result.count === 1;
}

export async function attachProviderJobIdToQueuedAiJob({
  jobId,
  kind,
  provider,
  providerJobId,
  expectedCallbackNonceHash,
  prisma,
}: {
  jobId: string;
  kind: string;
  provider: string;
  providerJobId: string;
  expectedCallbackNonceHash?: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const result = await db.aiJob.updateMany({
    where: {
      id: jobId,
      kind,
      provider,
      providerJobId: null,
      ...(expectedCallbackNonceHash
        ? { callbackNonceHash: expectedCallbackNonceHash }
        : {}),
      status: "queued",
      deletedAt: null,
    },
    data: {
      status: "running",
      providerJobId,
      error: null,
      providerPollLeaseExpiresAt: null,
      finalizationToken: null,
      finalizationLeaseExpiresAt: null,
    },
  });
  const job = await db.aiJob.findFirst({
    where: { id: jobId, deletedAt: null },
  });
  if (!job) {
    return { outcome: "notFound" as const, job: null };
  }
  if (
    job.kind !== kind ||
    job.provider !== provider ||
    job.providerJobId !== providerJobId
  ) {
    return { outcome: "conflict" as const, job };
  }
  return {
    outcome: result.count === 1
      ? "attached" as const
      : "alreadyAttached" as const,
    job,
  };
}

export async function getAiJobByProviderJobId({
  provider,
  providerJobId,
  prisma,
}: {
  provider: string;
  providerJobId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.aiJob.findFirst({
    where: { provider, providerJobId, deletedAt: null },
  });
}

export async function touchActiveAiJob({
  jobId,
  status,
  prisma,
}: {
  jobId: string;
  status: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const result = await db.aiJob.updateMany({
    where: {
      id: jobId,
      status,
      deletedAt: null,
    },
    data: {
      status,
    },
  });
  return result.count === 1;
}

export async function claimAiJobForProviderPoll({
  jobId,
  now,
  leaseExpiresAt,
  prisma,
}: {
  jobId: string;
  now: Date;
  leaseExpiresAt: Date;
  prisma?: PrismaTransaction;
}) {
  if (leaseExpiresAt.getTime() <= now.getTime()) {
    throw new RangeError("AI provider poll lease must expire in the future");
  }
  const db = prisma ?? await getDb();
  const updated = await db.aiJob.updateMany({
    where: {
      id: jobId,
      deletedAt: null,
      AND: [
        {
          OR: [
            { providerPollLeaseExpiresAt: null },
            { providerPollLeaseExpiresAt: { lte: now } },
          ],
        },
        {
          OR: [
            { status: "running" },
            {
              status: "finalizing",
              OR: [
                { finalizationToken: null },
                { finalizationLeaseExpiresAt: null },
                { finalizationLeaseExpiresAt: { lte: now } },
              ],
            },
          ],
        },
      ],
    },
    data: {
      providerPollLeaseExpiresAt: leaseExpiresAt,
    },
  });
  const job = await getAiJobById({ jobId, prisma: db });
  return { claimed: updated.count === 1, job };
}

export async function releaseAiJobProviderPoll({
  jobId,
  leaseExpiresAt,
  prisma,
}: {
  jobId: string;
  leaseExpiresAt: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const result = await db.aiJob.updateMany({
    where: {
      id: jobId,
      deletedAt: null,
      providerPollLeaseExpiresAt: leaseExpiresAt,
    },
    data: {
      providerPollLeaseExpiresAt: null,
    },
  });
  return result.count === 1;
}

export async function claimAiJobForFinalization({
  jobId,
  now,
  leaseExpiresAt,
  prisma,
}: {
  jobId: string;
  now: Date;
  leaseExpiresAt: Date;
  prisma?: PrismaTransaction;
}) {
  if (leaseExpiresAt.getTime() <= now.getTime()) {
    throw new RangeError("AI finalization lease must expire in the future");
  }
  const db = prisma ?? await getDb();
  const finalizationToken = crypto.randomUUID();
  const updated = await db.aiJob.updateMany({
    where: {
      id: jobId,
      deletedAt: null,
      OR: [
        { status: { in: ["queued", "running"] } },
        {
          status: "finalizing",
          OR: [
            { finalizationToken: null },
            { finalizationLeaseExpiresAt: null },
            { finalizationLeaseExpiresAt: { lte: now } },
          ],
        },
      ],
    },
    data: {
      status: "finalizing",
      providerPollLeaseExpiresAt: null,
      finalizationToken,
      finalizationLeaseExpiresAt: leaseExpiresAt,
      error: null,
    },
  });
  const job = await getAiJobById({ jobId, prisma: db });
  return updated.count === 1
    ? { claimed: true as const, finalizationToken, job }
    : { claimed: false as const, finalizationToken: null, job };
}

export async function renewAiJobFinalizationLease({
  jobId,
  finalizationToken,
  leaseExpiresAt,
  prisma,
}: {
  jobId: string;
  finalizationToken: string;
  leaseExpiresAt: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const result = await db.aiJob.updateMany({
    where: {
      id: jobId,
      status: "finalizing",
      finalizationToken,
      deletedAt: null,
    },
    data: {
      finalizationLeaseExpiresAt: leaseExpiresAt,
    },
  });
  return result.count === 1;
}

export async function markAiJobSucceeded({
  jobId,
  prisma,
}: {
  jobId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const result = await db.aiJob.updateMany({
    where: {
      id: jobId,
      deletedAt: null,
      status: "running",
    },
    data: {
      status: "succeeded",
      error: null,
      providerPollLeaseExpiresAt: null,
      finalizationToken: null,
      finalizationLeaseExpiresAt: null,
    },
  });
  return result.count === 1;
}

export type AiOutputFileInput = {
  objectKey: string;
  name: string;
  size: number;
  mimeType: string;
  userId: string;
  sha256: string;
};

export async function completeAiJobWithOutput({
  jobId,
  file,
  finalizationToken,
  retentionExpiresAt,
  prisma,
}: {
  jobId: string;
  file: AiOutputFileInput;
  finalizationToken?: string;
  retentionExpiresAt?: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const writeIntent = await tx.aiStorageCleanup.findFirst({
      where: {
        objectKey: file.objectKey,
        aiJobId: jobId,
        state: "writing",
      },
      select: { objectKey: true },
    });
    if (!writeIntent) return null;

    const output = await tx.file.create({
      data: {
        ...file,
        visibility: "PRIVATE",
      },
    });
    const updated = await tx.aiJob.updateMany({
      where: {
        id: jobId,
        userId: file.userId,
        deletedAt: null,
        ...(finalizationToken
          ? { status: "finalizing", finalizationToken }
          : { status: "running" }),
      },
      data: {
        status: "succeeded",
        resultFileId: output.id,
        error: null,
        providerPollLeaseExpiresAt: null,
        finalizationToken: null,
        finalizationLeaseExpiresAt: null,
      },
    });
    if (updated.count !== 1) {
      await tx.file.delete({ where: { id: output.id } });
      return null;
    }

    if (retentionExpiresAt) {
      const retained = await tx.aiStorageCleanup.updateMany({
        where: {
          objectKey: file.objectKey,
          aiJobId: jobId,
          state: "writing",
          leaseToken: null,
        },
        data: {
          state: "cleanup",
          notBefore: retentionExpiresAt,
          leaseToken: null,
        },
      });
      if (retained.count !== 1) {
        throw new Error(`AI output ${file.objectKey} retention was not saved`);
      }
    } else {
      const deletedCleanup = await tx.aiStorageCleanup.deleteMany({
        where: {
          objectKey: file.objectKey,
          aiJobId: jobId,
          state: "writing",
          leaseToken: null,
        },
      });
      if (deletedCleanup.count !== 1) {
        throw new Error(`AI output ${file.objectKey} cleanup intent changed`);
      }
    }
    return output;
  };

  return prisma ? await run(prisma) : await startTransaction(run);
}

export async function getAiJobById({
  jobId,
  prisma,
}: {
  jobId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.aiJob.findFirst({
    where: {
      id: jobId,
      deletedAt: null,
    },
    include: {
      resultFile: { select: AI_JOB_RESULT_FILE_SELECT },
    },
  });
}

export async function getAiJobResultFile({
  jobId,
  userId,
  prisma,
}: {
  jobId: string;
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const job = await db.aiJob.findFirst({
    where: {
      id: jobId,
      userId,
      deletedAt: null,
      resultFileId: { not: null },
    },
    include: {
      resultFile: true,
    },
  });
  return job?.resultFile ?? null;
}

export async function listAiJobsByUserId({
  userId,
  cursor,
  limit,
  prisma,
}: {
  userId: string;
  cursor?: AiJobHistoryCursor;
  limit: number;
  prisma?: PrismaTransaction;
}) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_AI_JOB_HISTORY_PAGE_SIZE
  ) {
    throw new RangeError(
      `AI job history limit must be between 1 and ${MAX_AI_JOB_HISTORY_PAGE_SIZE}`,
    );
  }

  const db = prisma ?? await getDb();
  const jobs = await db.aiJob.findMany({
    where: {
      userId,
      deletedAt: null,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              {
                createdAt: cursor.createdAt,
                id: { lt: cursor.id },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: {
      resultFile: { select: AI_JOB_RESULT_FILE_SELECT },
    },
  });
  const page = jobs.slice(0, limit);
  const last = page.at(-1);

  return {
    jobs: page,
    nextCursor:
      jobs.length > limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
  };
}

export async function getAiJobByUserId({
  userId,
  jobId,
  prisma,
}: {
  userId: string;
  jobId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.aiJob.findFirst({
    where: {
      id: jobId,
      userId,
      deletedAt: null,
    },
    include: {
      resultFile: { select: AI_JOB_RESULT_FILE_SELECT },
    },
  });
}

export async function prepareAiJobDeletionByUserId({
  userId,
  jobId,
  prisma,
}: {
  userId: string;
  jobId: string;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const job = await tx.aiJob.findFirst({
      where: {
        id: jobId,
        userId,
      },
    });
    if (!job) {
      return { outcome: "notFound" as const };
    }
    if (job.deletedAt === null && isActiveAiJobStatus(job.status)) {
      return { outcome: "active" as const };
    }

    if (job.deletedAt === null) {
      const updated = await tx.aiJob.updateMany({
        where: {
          id: jobId,
          userId,
          deletedAt: null,
          status: { notIn: ACTIVE_AI_JOB_STATUSES },
        },
        data: {
          inputParams: Prisma.DbNull,
          error: null,
          providerJobId: null,
          callbackNonceHash: null,
          providerPollLeaseExpiresAt: null,
          deletedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        return { outcome: "notFound" as const };
      }
    }

    const outputFile = job.resultFileId
      ? await tx.file.findFirst({
        where: {
          id: job.resultFileId,
          userId,
        },
        select: {
          id: true,
          objectKey: true,
          Package: { select: { id: true }, take: 1 },
          Profile: { select: { userId: true }, take: 1 },
          PackageScreenshot: {
            select: { packageId: true, fileId: true },
            take: 1,
          },
          Release: { select: { id: true }, take: 1 },
        },
      })
      : null;
    if (job.resultFileId && !outputFile) {
      throw new Error(`AI job ${jobId} has an invalid output ownership link`);
    }

    const sharedOutput = outputFile && (
      outputFile.Package.length > 0 ||
      outputFile.Profile.length > 0 ||
      outputFile.PackageScreenshot.length > 0 ||
      outputFile.Release.length > 0
    );
    if (sharedOutput) {
      const cleanupSnapshot = await tx.aiStorageCleanup.findFirst({
        where: { objectKey: outputFile.objectKey },
        select: {
          objectKey: true,
          aiJobId: true,
          leaseToken: true,
          state: true,
          notBefore: true,
        },
      });
      if (
        cleanupSnapshot?.leaseToken &&
        cleanupSnapshot.notBefore.getTime() <= Date.now()
      ) {
        // An expired cleanup lease may be taken over only through the same
        // cleanup claimant used by the reclaimer. This path is a cleanup
        // operation too; it must not mutate the row as a normal writer.
        const claimed = await claimAiStorageCleanupForDeletion({
          objectKey: cleanupSnapshot.objectKey,
          state: cleanupSnapshot.state,
          notBefore: cleanupSnapshot.notBefore,
          now: new Date(),
          leaseToken: cleanupSnapshot.leaseToken,
          prisma: tx,
        });
        if (!claimed.claimed) {
          throw new StorageCleanupBusyError([outputFile.objectKey]);
        }
        return { outcome: "prepared" as const, outputFile: null };
      }
      const cleanup = await findStorageCleanupForMutation(
        tx,
        outputFile.objectKey,
        new Date(),
      );
      const detached = await tx.aiJob.updateMany({
        where: {
          id: jobId,
          userId,
          resultFileId: outputFile.id,
        },
        data: { resultFileId: null },
      });
      if (detached.count !== 1) {
        throw new Error(`Shared AI output for job ${jobId} could not be detached`);
      }
      if (cleanup) {
        const deletedCleanup = await tx.aiStorageCleanup.deleteMany({
          where: {
            objectKey: outputFile.objectKey,
            leaseToken: cleanup.leaseToken,
          },
        });
        if (deletedCleanup.count !== 1) {
          throw new StorageCleanupBusyError([outputFile.objectKey]);
        }
      }
      return { outcome: "prepared" as const, outputFile: null };
    }

    if (outputFile) {
      const now = new Date();
      const existing = await findStorageCleanupForMutation(
        tx,
        outputFile.objectKey,
        now,
      );
      if (existing) {
        const updated = await tx.aiStorageCleanup.updateMany({
          where: {
            objectKey: outputFile.objectKey,
            leaseToken: existing.leaseToken,
          },
          data: {
            aiJobId: jobId,
            state: "cleanup",
            notBefore: now,
            leaseToken: null,
          },
        });
        if (updated.count !== 1) {
          throw new StorageCleanupBusyError([outputFile.objectKey]);
        }
      } else {
        await tx.aiStorageCleanup.create({
          data: {
            objectKey: outputFile.objectKey,
            aiJobId: jobId,
            state: "cleanup",
            notBefore: now,
            leaseToken: null,
          },
        });
      }
    }

    return { outcome: "prepared" as const, outputFile };
  };

  if (prisma) {
    return await run(prisma);
  }
  return await startTransaction(run);
}

export async function finalizeAiJobDeletionByUserId({
  userId,
  jobId,
  outputFileId,
  outputObjectKey,
  prisma,
}: {
  userId: string;
  jobId: string;
  outputFileId?: string;
  outputObjectKey?: string;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const unlinked = await tx.aiJob.updateMany({
      where: {
        id: jobId,
        userId,
        deletedAt: { not: null },
      },
      data: {
        resultFileId: null,
      },
    });
    if (unlinked.count !== 1) {
      throw new Error(`Deleted AI job ${jobId} could not be finalized`);
    }

    if (outputFileId) {
      const deleted = await tx.file.deleteMany({
        where: {
          id: outputFileId,
          userId,
        },
      });
      if (deleted.count !== 1) {
        const remaining = await tx.file.findFirst({
          where: { id: outputFileId },
          select: { id: true },
        });
        if (remaining) {
          throw new Error(`AI output File ${outputFileId} could not be deleted`);
        }
      }
    }
    if (outputObjectKey) {
      await findStorageCleanupForMutation(tx, outputObjectKey, new Date());
      await tx.aiStorageCleanup.deleteMany({
        where: { objectKey: outputObjectKey, leaseToken: null },
      });
    }
  };

  if (prisma) {
    await run(prisma);
  } else {
    await startTransaction(run);
  }
}

export async function registerAiStorageCleanup({
  objectKey,
  aiJobId,
  state = "writing",
  notBefore,
  prisma,
}: {
  objectKey: string;
  aiJobId: string;
  state?: "writing" | "cleanup";
  notBefore: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const existing = await findStorageCleanupForMutation(db, objectKey, new Date());
  if (existing) {
    const updated = await db.aiStorageCleanup.updateMany({
      where: { objectKey, leaseToken: existing.leaseToken },
      data: { aiJobId, state, notBefore, leaseToken: null },
    });
    if (updated.count !== 1) {
      throw new StorageCleanupBusyError([objectKey]);
    }
    return await db.aiStorageCleanup.findFirst({ where: { objectKey } });
  }
  return await db.aiStorageCleanup.create({
    data: { objectKey, aiJobId, state, notBefore, leaseToken: null },
  });
}

export async function makeAiStorageCleanupDue({
  objectKey,
  now = new Date(),
  prisma,
}: {
  objectKey: string;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const result = await db.aiStorageCleanup.updateMany({
    where: { objectKey, state: "writing", leaseToken: null },
    data: { state: "cleanup", notBefore: now },
  });
  return result.count === 1;
}

// A cleanup claim may perform two remote storage operations and then a
// transactional database finalization. Keep the row leased for the duration
// of the longest expected remote operation so concurrent sweepers cannot both
// act on the same object; an expired lease remains eligible for retry.
export const AI_STORAGE_CLEANUP_LEASE_MILLISECONDS = 5 * 60 * 1000;

export type AiStorageCleanupClaim = {
  objectKey: string;
  aiJobId: string | null;
  leaseToken: string;
  notBefore: Date;
};

export async function claimAiStorageCleanupForDeletion({
  objectKey,
  state,
  notBefore,
  now,
  leaseToken = null,
  prisma,
}: {
  objectKey: string;
  state: string;
  notBefore: Date;
  now: Date;
  leaseToken?: string | null;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const multipartPending = await tx.storageMultipartCleanup.findFirst({
      where: { objectKey, status: { in: ["pending", "processing", "retry", "intervention"] } },
      orderBy: { notBefore: "desc" },
      select: { notBefore: true },
    });
    if (multipartPending) {
      const deferredUntil = new Date(Math.max(
        notBefore.getTime(),
        now.getTime() + STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS,
        multipartPending.notBefore.getTime() +
          STORAGE_MULTIPART_SETTLEMENT_GRACE_MILLISECONDS,
      ));
      await tx.aiStorageCleanup.updateMany({
        where: { objectKey, state, notBefore, leaseToken },
        data: {
          state: "cleanup",
          leaseToken: null,
          notBefore: deferredUntil,
        },
      });
      return { claimed: false as const, shouldDeleteObject: false as const };
    }
    const nextLeaseToken = crypto.randomUUID();
    const result = await tx.aiStorageCleanup.updateMany({
      where: {
        objectKey,
        state,
        notBefore,
        leaseToken,
      },
      data: {
        state: "cleanup",
        notBefore: new Date(
          now.getTime() + AI_STORAGE_CLEANUP_LEASE_MILLISECONDS,
        ),
        leaseToken: nextLeaseToken,
      },
    });
    if (result.count !== 1) {
      return { claimed: false as const, shouldDeleteObject: false as const };
    }

    const cleanup = await tx.aiStorageCleanup.findFirst({
      where: { objectKey },
      select: {
        objectKey: true,
        aiJobId: true,
        leaseToken: true,
        notBefore: true,
      },
    });
    if (!cleanup || cleanup.leaseToken !== nextLeaseToken) {
      return { claimed: false as const, shouldDeleteObject: false as const };
    }
    const claimedCleanup: AiStorageCleanupClaim = {
      objectKey: cleanup.objectKey,
      aiJobId: cleanup.aiJobId,
      leaseToken: nextLeaseToken,
      notBefore: cleanup.notBefore,
    };
    if (!cleanup?.aiJobId) {
      return {
        claimed: true as const,
        shouldDeleteObject: true as const,
        cleanup: claimedCleanup,
      };
    }

    const job = await tx.aiJob.findUnique({
      where: { id: cleanup.aiJobId },
      select: { id: true, userId: true, resultFileId: true },
    });
    if (!job?.resultFileId) {
      return {
        claimed: true as const,
        shouldDeleteObject: true as const,
        cleanup: claimedCleanup,
      };
    }
    const output = await tx.file.findFirst({
      where: { id: job.resultFileId, userId: job.userId },
      select: {
        id: true,
        objectKey: true,
        Package: { select: { id: true }, take: 1 },
        Profile: { select: { userId: true }, take: 1 },
        PackageScreenshot: {
          select: { packageId: true, fileId: true },
          take: 1,
        },
        Release: { select: { id: true }, take: 1 },
      },
    });
    if (!output) {
      return {
        claimed: true as const,
        shouldDeleteObject: true as const,
        cleanup: claimedCleanup,
      };
    }
    if (output.objectKey !== objectKey) {
      throw new Error(
        `AI cleanup ${objectKey} does not own output ${output.objectKey}`,
      );
    }

    const shared =
      output.Package.length > 0 ||
      output.Profile.length > 0 ||
      output.PackageScreenshot.length > 0 ||
      output.Release.length > 0;
    if (!shared) {
      return {
        claimed: true as const,
        shouldDeleteObject: true as const,
        cleanup: claimedCleanup,
      };
    }

    const detached = await tx.aiJob.updateMany({
      where: {
        id: job.id,
        userId: job.userId,
        resultFileId: output.id,
      },
      data: { resultFileId: null },
    });
    if (detached.count !== 1) {
      throw new Error(`Shared AI output for job ${job.id} could not be detached`);
    }
    const detachedCleanup = await tx.aiStorageCleanup.deleteMany({
      where: { objectKey, leaseToken: nextLeaseToken },
    });
    if (detachedCleanup.count !== 1) {
      throw new Error(`AI cleanup ${objectKey} claim changed before detach`);
    }
    return { claimed: true as const, shouldDeleteObject: false as const };
  };

  if (prisma) return await run(prisma);
  return await startTransaction(run);
}

export async function findCommittedAiOutput({
  jobId,
  userId,
  objectKey,
  prisma,
}: {
  jobId: string;
  userId: string;
  objectKey: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const job = await db.aiJob.findFirst({
    where: {
      id: jobId,
      userId,
      status: "succeeded",
      deletedAt: null,
    },
    select: { resultFileId: true },
  });
  if (!job?.resultFileId) return null;
  const file = await db.file.findFirst({
    where: {
      id: job.resultFileId,
      userId,
    },
  });
  return file?.objectKey === objectKey ? file : null;
}

export async function deleteAiStorageCleanup({
  objectKey,
  prisma,
}: {
  objectKey: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  await findStorageCleanupForMutation(db, objectKey, new Date());
  await db.aiStorageCleanup.deleteMany({
    where: { objectKey, leaseToken: null },
  });
}

export async function finalizeReconciledAiStorageCleanup({
  objectKey,
  aiJobId,
  leaseToken,
  prisma,
}: {
  objectKey: string;
  aiJobId: string | null;
  leaseToken: string;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    const claim = await tx.aiStorageCleanup.findFirst({
      where: { objectKey, leaseToken },
      select: { aiJobId: true },
    });
    if (!claim || claim.aiJobId !== aiJobId) return false;
    if (aiJobId) {
      const job = await tx.aiJob.findUnique({ where: { id: aiJobId } });
      if (job?.resultFileId) {
        const output = await tx.file.findFirst({
          where: {
            id: job.resultFileId,
            userId: job.userId,
          },
          select: { id: true, objectKey: true },
        });
        if (output && output.objectKey !== objectKey) {
          throw new Error(
            `AI cleanup ${objectKey} does not own output ${output.objectKey}`,
          );
        }
        if (output) {
          const unlinked = await tx.aiJob.updateMany({
            where: {
              id: job.id,
              userId: job.userId,
              resultFileId: output.id,
            },
            data: { resultFileId: null },
          });
          if (unlinked.count !== 1) {
            throw new Error(`AI job ${job.id} output could not be unlinked`);
          }
          const deleted = await tx.file.deleteMany({
            where: { id: output.id, userId: job.userId },
          });
          if (deleted.count !== 1) {
            throw new Error(`AI output File ${output.id} could not be deleted`);
          }
        }
      }
    }
    const finalized = await tx.aiStorageCleanup.deleteMany({
      where: { objectKey, leaseToken },
    });
    return finalized.count === 1;
  };

  return prisma ? await run(prisma) : await startTransaction(run);
}

export async function listDueAiStorageCleanups({
  now,
  limit = 100,
  prisma,
}: {
  now: Date;
  limit?: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.aiStorageCleanup.findMany({
    where: { notBefore: { lte: now } },
    orderBy: { notBefore: "asc" },
    take: limit,
  });
}

export function hasFreshAiJobFinalizationLease(
  job: {
    status: string;
    finalizationToken: string | null;
    finalizationLeaseExpiresAt: Date | null;
  },
  now: Date,
): boolean {
  return (
    job.status === "finalizing" &&
    job.finalizationToken !== null &&
    job.finalizationLeaseExpiresAt !== null &&
    job.finalizationLeaseExpiresAt.getTime() > now.getTime()
  );
}

// Count active jobs of one kind so a synchronous image or transcription job
// cannot consume the user's independent video-generation slot.
export async function countActiveAiJobsByUserIdAndKind({
  userId,
  kind,
  prisma,
}: {
  userId: string;
  kind: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.aiJob.count({
    where: {
      userId,
      kind,
      deletedAt: null,
      status: {
        in: ACTIVE_AI_JOB_STATUSES,
      },
    },
  });
}

export async function listActiveAiJobsForReconciliation({
  updatedBefore,
  limit = 100,
  prisma,
}: {
  updatedBefore: Date;
  limit?: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.aiJob.findMany({
    where: {
      deletedAt: null,
      status: { in: ACTIVE_AI_JOB_STATUSES },
      updatedAt: { lte: updatedBefore },
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
}

export async function enqueueUserRemoteAiJobCleanups({
  userId,
  now,
  prisma,
}: {
  userId: string;
  now: Date;
  prisma: PrismaTransaction;
}) {
  const jobs = await prisma.aiJob.findMany({
    where: {
      userId,
      deletedAt: null,
      status: { in: ACTIVE_AI_JOB_STATUSES },
      providerJobId: { not: null },
    },
    select: { provider: true, providerJobId: true },
  });
  for (const job of jobs) {
    if (!job.providerJobId) continue;
    await enqueueAiRemoteJobCleanup({
      provider: job.provider,
      providerJobId: job.providerJobId,
      now,
      prisma,
    });
  }
  return jobs.length;
}

export async function enqueueAiRemoteJobCleanup({
  provider,
  providerJobId,
  now = new Date(),
  prisma,
}: {
  provider: string;
  providerJobId: string;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) =>
    await tx.aiRemoteJobCleanup.upsert({
      where: {
        provider_providerJobId: { provider, providerJobId },
      },
      create: { provider, providerJobId, notBefore: now },
      update: { notBefore: now },
    });
  return prisma ? await run(prisma) : await startRetryableTransaction(run);
}

export async function listDueAiRemoteJobCleanups({
  now,
  limit = 100,
  prisma,
}: {
  now: Date;
  limit?: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.aiRemoteJobCleanup.findMany({
    where: {
      notBefore: { lte: now },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    orderBy: { notBefore: "asc" },
    take: limit,
  });
}

export async function claimAiRemoteJobCleanup({
  provider,
  providerJobId,
  now,
  leaseExpiresAt,
  prisma,
}: {
  provider: string;
  providerJobId: string;
  now: Date;
  leaseExpiresAt: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const updated = await db.aiRemoteJobCleanup.updateMany({
    where: {
      provider,
      providerJobId,
      notBefore: { lte: now },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: { leaseExpiresAt },
  });
  if (updated.count !== 1) return null;
  return await db.aiRemoteJobCleanup.findUnique({
    where: { provider_providerJobId: { provider, providerJobId } },
  });
}

export async function rescheduleAiRemoteJobCleanup({
  provider,
  providerJobId,
  leaseExpiresAt,
  notBefore,
  lastError,
  prisma,
}: {
  provider: string;
  providerJobId: string;
  leaseExpiresAt: Date;
  notBefore: Date;
  lastError: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.aiRemoteJobCleanup.updateMany({
    where: { provider, providerJobId, leaseExpiresAt },
    data: {
      notBefore,
      leaseExpiresAt: null,
      attempts: { increment: 1 },
      lastError,
    },
  });
}

export async function completeAiRemoteJobCleanup({
  provider,
  providerJobId,
  leaseExpiresAt,
  prisma,
}: {
  provider: string;
  providerJobId: string;
  leaseExpiresAt: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.aiRemoteJobCleanup.deleteMany({
    where: { provider, providerJobId, leaseExpiresAt },
  });
}
