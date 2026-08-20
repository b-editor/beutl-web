-- CreateTable
CREATE TABLE "GitAccountDeletion" (
    "userId" STRING NOT NULL,
    "forgejoUsername" STRING NOT NULL,
    "forgejoUserId" INT4 NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INT4 NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" STRING,

    CONSTRAINT "GitAccountDeletion_pkey" PRIMARY KEY ("userId")
);
