-- CreateEnum
CREATE TYPE "FeedbackCategory" AS ENUM ('BUG_REPORT', 'FEATURE_REQUEST', 'QUESTION', 'OTHER');

-- CreateTable
CREATE TABLE "Feedback" (
    "id" STRING NOT NULL,
    "name" STRING NOT NULL,
    "email" STRING NOT NULL,
    "category" "FeedbackCategory" NOT NULL,
    "message" STRING NOT NULL,
    "userId" STRING,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
