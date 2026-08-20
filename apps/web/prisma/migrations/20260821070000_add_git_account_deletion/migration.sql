-- CreateEnum
CREATE TYPE "GitAccountDeletionPhase" AS ENUM ('BLOCKING', 'READY_TO_PURGE', 'NEEDS_REVIEW');

-- CreateTable
CREATE TABLE "GitAccountDeletion" (
    "userId" STRING NOT NULL,
    "intentId" STRING NOT NULL,
    "phase" "GitAccountDeletionPhase" NOT NULL DEFAULT 'BLOCKING',
    "forgejoUsername" STRING,
    "forgejoUserId" INT4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INT4 NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" STRING,

    CONSTRAINT "GitAccountDeletion_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "GitAccountDeletion_phase_idx" ON "GitAccountDeletion"("phase");
