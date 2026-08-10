-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED');

-- AlterTable
ALTER TABLE "Feedback" ADD COLUMN "status" "FeedbackStatus" NOT NULL DEFAULT 'OPEN';
