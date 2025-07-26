-- CreateTable
CREATE TABLE "ConfirmationToken" (
    "userId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfirmationToken_pkey" PRIMARY KEY ("identifier","token")
);

-- AddForeignKey
ALTER TABLE "ConfirmationToken" ADD CONSTRAINT "ConfirmationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
