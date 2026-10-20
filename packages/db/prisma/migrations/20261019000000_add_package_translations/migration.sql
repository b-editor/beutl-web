CREATE TABLE "PackageTranslation" (
  "packageId" STRING NOT NULL,
  "lang" STRING NOT NULL,
  "shortDescription" STRING,
  "description" STRING,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PackageTranslation_pkey" PRIMARY KEY ("packageId", "lang"),
  CONSTRAINT "PackageTranslation_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "ReleaseTranslation" (
  "releaseId" STRING NOT NULL,
  "lang" STRING NOT NULL,
  "description" STRING,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReleaseTranslation_pkey" PRIMARY KEY ("releaseId", "lang"),
  CONSTRAINT "ReleaseTranslation_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
