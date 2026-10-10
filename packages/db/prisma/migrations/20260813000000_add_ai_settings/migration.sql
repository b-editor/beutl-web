-- Administrator-configurable AI runtime settings (model IDs and unit prices).
-- One row per setting; the key domain is validated in application code
-- (@beutl/core ai-settings) rather than by a database enum, so adding a model
-- does not require a migration.
-- A missing key falls back to the environment variable and then to the built-in
-- default, so AI features behave exactly as before while this table is empty.

-- CreateTable
CREATE TABLE "AiSetting" (
    "key" STRING NOT NULL,
    "value" STRING NOT NULL,
    "updatedBy" STRING,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSetting_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "AiSetting" SET (schema_locked = false);

-- CreateIndex
CREATE INDEX "AiSetting_updatedBy_idx" ON "AiSetting"("updatedBy");

-- AddForeignKey
-- Keep the setting when the administrator who changed it is deleted.
ALTER TABLE "AiSetting" ADD CONSTRAINT "AiSetting_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
