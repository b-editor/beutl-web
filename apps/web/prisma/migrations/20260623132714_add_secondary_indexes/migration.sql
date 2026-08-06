-- CreateIndex
CREATE INDEX "File_userId_idx" ON "File"("userId");

-- CreateIndex
CREATE INDEX "Package_userId_idx" ON "Package"("userId");

-- CreateIndex
CREATE INDEX "UserPaymentHistory_userId_idx" ON "UserPaymentHistory"("userId");

-- CreateIndex
CREATE INDEX "UserPackage_packageId_idx" ON "UserPackage"("packageId");

-- CreateIndex
CREATE INDEX "Release_packageId_idx" ON "Release"("packageId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AppReleaseAsset_version_type_os_arch_standalone_idx" ON "AppReleaseAsset"("version", "type", "os", "arch", "standalone");
