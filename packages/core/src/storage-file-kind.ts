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

// Repository files carry no stored type; their name decides it, the way the
// desktop and browsers treat them. Anything unknown is plain bytes.
const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  apng: "image/apng", avif: "image/avif", bmp: "image/bmp", gif: "image/gif", ico: "image/x-icon",
  jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", svg: "image/svg+xml", tif: "image/tiff",
  tiff: "image/tiff", webp: "image/webp",
  m4v: "video/mp4", mkv: "video/x-matroska", mov: "video/quicktime", mp4: "video/mp4", ogv: "video/ogg",
  webm: "video/webm", avi: "video/x-msvideo",
  aac: "audio/aac", flac: "audio/flac", m4a: "audio/mp4", mp3: "audio/mpeg", oga: "audio/ogg",
  ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", weba: "audio/webm",
  // Beutl projects, scenes and elements are JSON documents.
  bep: "application/json", scene: "application/json", belm: "application/json",
  json: "application/json", xml: "application/xml", yaml: "application/yaml", yml: "application/yaml",
  csv: "text/csv", md: "text/markdown", txt: "text/plain", html: "text/html", htm: "text/html",
  css: "text/css", js: "application/javascript", cs: "text/plain", ts: "text/plain",
  gitattributes: "text/plain", gitignore: "text/plain",
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
};

export function mimeTypeFromFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  return MIME_TYPES_BY_EXTENSION[dot < 0 ? "" : name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}
