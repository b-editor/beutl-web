-- Match owner-scoped child listing and its (name, id) continuation order.
CREATE INDEX "File_userId_folderId_name_id_idx" ON "File"("userId", "folderId", "name", "id");
CREATE INDEX "StorageFolder_userId_parentId_name_id_idx" ON "StorageFolder"("userId", "parentId", "name", "id");
