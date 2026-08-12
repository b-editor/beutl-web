-- A finalizer owns a renewable lease. A timeout/refund may only take over
-- after that lease expires, and completion must present the matching token.
ALTER TABLE "AiJob" ADD COLUMN "finalizationToken" STRING;
ALTER TABLE "AiJob" ADD COLUMN "finalizationLeaseExpiresAt" TIMESTAMP(3);

-- Make the AI-output ownership relation explicit. Besides enforcing a single
-- owning job, this lets ordinary storage operations exclude AI-owned files and
-- lets content access treat legacy PUBLIC outputs as private.
UPDATE "AiJob"
SET "resultFileId" = NULL
WHERE "resultFileId" IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM "File"
      WHERE "File"."id" = "AiJob"."resultFileId"
  );

-- Legacy AI outputs were ordinary File records and could be promoted into
-- package icons, profile icons, screenshots, or release assets. Those shared
-- files must remain ordinary user assets: making them AI-owned would force
-- private access and job deletion would remove bytes still used elsewhere.
UPDATE "AiJob"
SET "resultFileId" = NULL
WHERE "resultFileId" IS NOT NULL
  AND EXISTS (
      SELECT 1
      FROM "File"
      WHERE "File"."id" = "AiJob"."resultFileId"
        AND (
            "File"."userId" <> "AiJob"."userId"
            OR EXISTS (
                SELECT 1 FROM "Package"
                WHERE "Package"."iconFileId" = "File"."id"
            )
            OR EXISTS (
                SELECT 1 FROM "Profile"
                WHERE "Profile"."iconFileId" = "File"."id"
            )
            OR EXISTS (
                SELECT 1 FROM "PackageScreenshot"
                WHERE "PackageScreenshot"."fileId" = "File"."id"
            )
            OR EXISTS (
                SELECT 1 FROM "Release"
                WHERE "Release"."fileId" = "File"."id"
            )
        )
  );

-- Older rows did not enforce one output owner. Retain one deterministic job
-- link for each remaining private file and detach duplicates before adding the
-- unique index.
WITH "RankedAiOutputs" AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "resultFileId"
            ORDER BY "createdAt", "id"
        ) AS "ownerRank"
    FROM "AiJob"
    WHERE "resultFileId" IS NOT NULL
)
UPDATE "AiJob"
SET "resultFileId" = NULL
FROM "RankedAiOutputs"
WHERE "AiJob"."id" = "RankedAiOutputs"."id"
  AND "RankedAiOutputs"."ownerRank" > 1;

CREATE UNIQUE INDEX "AiJob_resultFileId_key" ON "AiJob"("resultFileId");

ALTER TABLE "AiJob"
ADD CONSTRAINT "AiJob_resultFileId_fkey"
FOREIGN KEY ("resultFileId") REFERENCES "File"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- An intent row is written before an R2 put. Successful DB finalization removes
-- it transactionally; otherwise scheduled reconciliation can durably retry R2
-- cleanup even if the immediate compensating delete also fails.
CREATE TABLE "AiStorageCleanup" (
    "objectKey" STRING NOT NULL,
    "aiJobId" STRING,
    "state" STRING NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiStorageCleanup_pkey" PRIMARY KEY ("objectKey"),
    CONSTRAINT "AiStorageCleanup_state_check"
        CHECK ("state" IN ('writing', 'cleanup'))
);

ALTER TABLE "AiStorageCleanup" SET (schema_locked = false);

CREATE INDEX "AiStorageCleanup_notBefore_idx"
ON "AiStorageCleanup"("notBefore");

ALTER TABLE "AiStorageCleanup"
ADD CONSTRAINT "AiStorageCleanup_aiJobId_fkey"
FOREIGN KEY ("aiJobId") REFERENCES "AiJob"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
