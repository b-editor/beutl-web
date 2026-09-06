import type { FileVisibility } from "@prisma/client";

export interface StorageFile {
  id: string;
  name: string;
  size: bigint;
  visibility: FileVisibility;
  mimeType: string;
  createdAt: Date;
  folderId: string | null;
}

export interface StorageFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
}
