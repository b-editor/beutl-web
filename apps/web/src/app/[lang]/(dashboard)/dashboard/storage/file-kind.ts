import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  type LucideIcon,
} from "lucide-react";
import type { StorageFile } from "./types";

export type FileKind =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "archive"
  | "other";

export const FILE_KINDS: readonly FileKind[] = [
  "image",
  "video",
  "audio",
  "document",
  "archive",
  "other",
];

// React escapes file names when it renders them; i18next must not escape them
// a second time, or "a&b.png" would read "a&amp;b.png".
export const RAW = { interpolation: { escapeValue: false } } as const;

export function contentUrl(file: Pick<StorageFile, "id">): string {
  return `/api/contents/${file.id}`;
}

// Files registered from other screens (package icons, releases, screenshots,
// profile images) are managed there; this screen can only look at them.
export function isDedicated(file: Pick<StorageFile, "visibility">): boolean {
  return file.visibility === "DEDICATED";
}

export function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0].trim().toLowerCase();
}

const ARCHIVE_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
]);

const DOCUMENT_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/rtf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

// Only what the content route serves inline as an image. Anything else comes
// back as a download and would not render in an <img>.
const THUMBNAIL_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/x-icon",
]);

// There is no thumbnail service; the grid shows the original. Past this size
// a page of cards would pull more than a video's worth of bytes.
export const THUMBNAIL_MAX_BYTES = 8 * 1024 * 1024;

export function fileKind(mimeType: string): FileKind {
  const type = normalizeMimeType(mimeType);
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (ARCHIVE_TYPES.has(type)) return "archive";
  if (type.startsWith("text/") || DOCUMENT_TYPES.has(type)) return "document";
  return "other";
}

const KIND_ICONS: Record<FileKind, LucideIcon> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  document: FileText,
  archive: FileArchive,
  other: FileIcon,
};

export function fileKindIcon(kind: FileKind): LucideIcon {
  return KIND_ICONS[kind];
}

export function hasThumbnail(
  file: Pick<StorageFile, "mimeType" | "size">,
): boolean {
  const size = Number(file.size);
  return (
    THUMBNAIL_TYPES.has(normalizeMimeType(file.mimeType)) &&
    size > 0 &&
    size <= THUMBNAIL_MAX_BYTES
  );
}

export function openFile(file: Pick<StorageFile, "id">): void {
  window.open(contentUrl(file), "_blank", "noopener,noreferrer");
}

// Same-origin, so the download attribute overrides the inline disposition the
// content route sends for media.
export function downloadFile(file: Pick<StorageFile, "id" | "name">): void {
  const anchor = document.createElement("a");
  anchor.href = contentUrl(file);
  anchor.download = file.name;
  anchor.rel = "noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
