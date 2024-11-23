/*
  Warnings:

  - You are about to drop the column `pricingId` on the `UserPaymentHistory` table. All the data in the column will be lost.
  - Added the required column `packageId` to the `UserPaymentHistory` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "UserPaymentHistory" DROP CONSTRAINT "UserPaymentHistory_pricingId_fkey";

-- AlterTable
ALTER TABLE "UserPaymentHistory" DROP COLUMN "pricingId",
ADD COLUMN     "packageId" TEXT NOT NULL;
