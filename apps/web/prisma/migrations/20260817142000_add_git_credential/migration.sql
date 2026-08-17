-- CreateTable
CREATE TABLE "GitCredential" (
    "id" STRING NOT NULL,
    "userId" STRING NOT NULL,
    "name" STRING NOT NULL,
    "forgejoTokenId" INT4 NOT NULL,
    "lastEight" STRING NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GitCredential_userId_idx" ON "GitCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GitCredential_userId_name_key" ON "GitCredential"("userId", "name");

-- AddForeignKey
ALTER TABLE "GitCredential" ADD CONSTRAINT "GitCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

