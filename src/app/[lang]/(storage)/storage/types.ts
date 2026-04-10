import type { FileVisibility } from "@/db/types";

export interface File {
  id: string;
  name: string;
  size: number;
  visibility: FileVisibility;
  mimeType: string;
  objectKey: string;
}
