// ストレージ画面の一覧の状態。フォルダー・検索語・種類・公開設定・並び順・ページを
// URL のクエリで持ち、サーバーがそのぶんだけ取ってくる。画面は受け取った 1 ページを
// 表示し、操作は URL を変えることでサーバーに次を頼む。
import { isFileKind, type FileKind } from "./storage-file-kind";

export const STORAGE_LIST_PAGE_SIZE = 24;

export const STORAGE_LIST_SORT_FIELDS = ["name", "size", "createdAt"] as const;
export type StorageListSortField = (typeof STORAGE_LIST_SORT_FIELDS)[number];

export const STORAGE_LIST_VISIBILITIES = ["PUBLIC", "PRIVATE", "DEDICATED"] as const;
export type StorageListVisibility = (typeof STORAGE_LIST_VISIBILITIES)[number];

export type StorageListingParams = {
  // null は root。検索中はフォルダーに関係なく全体から探す (Drive と同じ)。
  folderId: string | null;
  query: string;
  kind: FileKind | null;
  visibility: StorageListVisibility | null;
  sort: StorageListSortField;
  descending: boolean;
  // 1 始まり。
  page: number;
};

export const DEFAULT_STORAGE_LISTING: StorageListingParams = {
  folderId: null,
  query: "",
  kind: null,
  visibility: null,
  sort: "createdAt",
  descending: true,
  page: 1,
};

function isSortField(value: unknown): value is StorageListSortField {
  return (
    typeof value === "string" &&
    (STORAGE_LIST_SORT_FIELDS as readonly string[]).includes(value)
  );
}

function isVisibility(value: unknown): value is StorageListVisibility {
  return (
    typeof value === "string" &&
    (STORAGE_LIST_VISIBILITIES as readonly string[]).includes(value)
  );
}

type SearchInput =
  | URLSearchParams
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

function readParam(input: SearchInput, key: string): string | null {
  if (!input) return null;
  if (input instanceof URLSearchParams) return input.get(key);
  const value = input[key];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export function storageListingSearching(params: Pick<StorageListingParams, "query">): boolean {
  return params.query.trim().length > 0;
}

// 壊れた値は黙って既定に戻す。URL は利用者が触れるものなので、例外にはしない。
export function parseStorageListingParams(input: SearchInput): StorageListingParams {
  const folder = readParam(input, "folder");
  const kind = readParam(input, "kind");
  const visibility = readParam(input, "visibility");
  const sort = readParam(input, "sort");
  const dir = readParam(input, "dir");
  const page = Number(readParam(input, "page") ?? "1");
  return {
    folderId: folder && folder.length > 0 ? folder : null,
    query: readParam(input, "q") ?? "",
    kind: isFileKind(kind) ? kind : null,
    visibility: isVisibility(visibility) ? visibility : null,
    sort: isSortField(sort) ? sort : DEFAULT_STORAGE_LISTING.sort,
    descending: dir === "asc" ? false : dir === "desc" ? true : sortDefaultsDescending(isSortField(sort) ? sort : DEFAULT_STORAGE_LISTING.sort),
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
}

// 名前は昇順、大きさと日時は降順が自然な既定。
export function sortDefaultsDescending(sort: StorageListSortField): boolean {
  return sort !== "name";
}

// 既定と同じ値は書かないので、素の /dashboard/storage が root の既定表示になる。
export function storageListingSearch(params: StorageListingParams): string {
  const search = new URLSearchParams();
  if (params.folderId) search.set("folder", params.folderId);
  if (params.query.length > 0) search.set("q", params.query);
  if (params.kind) search.set("kind", params.kind);
  if (params.visibility) search.set("visibility", params.visibility);
  if (params.sort !== DEFAULT_STORAGE_LISTING.sort) search.set("sort", params.sort);
  if (params.descending !== sortDefaultsDescending(params.sort)) {
    search.set("dir", params.descending ? "desc" : "asc");
  }
  if (params.page > 1) search.set("page", String(params.page));
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}
