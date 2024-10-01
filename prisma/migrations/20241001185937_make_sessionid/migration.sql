/*
  Warnings:

  - Made the column `id` on table `Session` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Session" ALTER COLUMN "id" SET NOT NULL,
ADD CONSTRAINT "Session_pkey" PRIMARY KEY ("id");
