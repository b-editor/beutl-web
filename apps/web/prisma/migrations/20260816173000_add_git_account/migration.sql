-- CreateTable
CREATE TABLE "GitAccount" (
    "userId" STRING NOT NULL,
    "forgejoUserId" INT4 NOT NULL,
    "forgejoUsername" STRING NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitAccount_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "GitAccount_forgejoUserId_key" ON "GitAccount"("forgejoUserId");

-- CreateIndex
CREATE UNIQUE INDEX "GitAccount_forgejoUsername_key" ON "GitAccount"("forgejoUsername");

-- AddForeignKey
ALTER TABLE "GitAccount" ADD CONSTRAINT "GitAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
