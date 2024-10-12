import type { FileVisibility } from "@prisma/client";

export interface File {
  id: string;
  name: string;
  size: bigint;
  visibility: FileVisibility;
  mimeType: string;
  objectKey: string;
};
