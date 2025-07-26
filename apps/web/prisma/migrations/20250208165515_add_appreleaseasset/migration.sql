-- CreateTable
CREATE TABLE "AppReleaseAsset" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "standalone" BOOLEAN NOT NULL,
    "url" TEXT NOT NULL,

    CONSTRAINT "AppReleaseAsset_pkey" PRIMARY KEY ("id")
);
