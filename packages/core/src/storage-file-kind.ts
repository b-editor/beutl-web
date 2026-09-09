// ストレージ画面の「種類」フィルタ。画面の表示 (アイコン) と一覧クエリの絞り込み
// (packages/db) が同じ判定を使えるように、MIME の集合と判定をここに置く。
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

export function isFileKind(value: unknown): value is FileKind {
  return typeof value === "string" && (FILE_KINDS as readonly string[]).includes(value);
}

export function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0].trim().toLowerCase();
}

export const ARCHIVE_MIME_TYPES: readonly string[] = [
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
];

export const DOCUMENT_MIME_TYPES: readonly string[] = [
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
];

const ARCHIVE_TYPES = new Set(ARCHIVE_MIME_TYPES);
const DOCUMENT_TYPES = new Set(DOCUMENT_MIME_TYPES);

export function fileKind(mimeType: string): FileKind {
  const type = normalizeMimeType(mimeType);
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (ARCHIVE_TYPES.has(type)) return "archive";
  if (type.startsWith("text/") || DOCUMENT_TYPES.has(type)) return "document";
  return "other";
}
