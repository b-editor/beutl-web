-- CreateTable
CREATE TABLE "Profile" (
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "bio" TEXT,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "SocialProfile" (
    "value" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,

    CONSTRAINT "SocialProfile_pkey" PRIMARY KEY ("userId","providerId")
);

-- CreateTable
CREATE TABLE "SocialProfileProvider" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "urlTemplate" TEXT NOT NULL,

    CONSTRAINT "SocialProfileProvider_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialProfile" ADD CONSTRAINT "SocialProfile_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "SocialProfileProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialProfile" ADD CONSTRAINT "SocialProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
