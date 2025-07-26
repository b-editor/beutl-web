/*
  Warnings:

  - Added the required column `purpose` to the `ConfirmationToken` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ConfirmationTokenPurpose" AS ENUM ('EMAIL_UPDATE', 'ACCOUNT_DELETE');

-- AlterTable
ALTER TABLE "ConfirmationToken" ADD COLUMN     "purpose" "ConfirmationTokenPurpose" NOT NULL;
