-- Normalize any legacy duplicate orders deterministically before adding the
-- invariant. New writes are allocated as max(order)+1 inside a transaction.
WITH ranked AS (
  SELECT
    "packageId",
    "fileId",
    ROW_NUMBER() OVER (
      PARTITION BY "packageId"
      ORDER BY "order" ASC, "createdAt" ASC, "fileId" ASC
    ) - 1 AS "newOrder"
  FROM "PackageScreenshot"
)
UPDATE "PackageScreenshot" AS screenshot
SET "order" = ranked."newOrder"
FROM ranked
WHERE screenshot."packageId" = ranked."packageId"
  AND screenshot."fileId" = ranked."fileId"
  AND screenshot."order" <> ranked."newOrder";

CREATE UNIQUE INDEX "PackageScreenshot_packageId_order_key"
  ON "PackageScreenshot" ("packageId", "order");
