/*
  Warnings:

  - Added the required column `sha256` to the `File` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "File" ADD COLUMN     "sha256" TEXT NOT NULL;
