/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `Package` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Package" ADD COLUMN     "displayName" TEXT;

-- CreateTable
CREATE TABLE "CompatPackage" (
    "id" BIGSERIAL NOT NULL,
    "packageId" TEXT NOT NULL,

    CONSTRAINT "CompatPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompatRelease" (
    "id" BIGSERIAL NOT NULL,
    "releaseId" TEXT NOT NULL,

    CONSTRAINT "CompatRelease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompatPackage_packageId_key" ON "CompatPackage"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "CompatRelease_releaseId_key" ON "CompatRelease"("releaseId");

-- CreateIndex
CREATE UNIQUE INDEX "Package_name_key" ON "Package"("name");

-- AddForeignKey
ALTER TABLE "CompatPackage" ADD CONSTRAINT "CompatPackage_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompatRelease" ADD CONSTRAINT "CompatRelease_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;
