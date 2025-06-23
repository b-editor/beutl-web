import type { fileVisibility } from "@/drizzle/schema";

export type FileVisibility = typeof fileVisibility.enumValues[number];

export interface File {
  id: string;
  name: string;
  size: number;
  visibility: FileVisibility;
  mimeType: string;
  objectKey: string;
}
