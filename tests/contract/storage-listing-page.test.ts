import { beforeEach, describe, expect, it } from "vitest";
import {
  countStorageFilesInFolders,
  retrieveStorageFilesPage,
  setDbProvider,
} from "@beutl/db";
import {
  DEFAULT_STORAGE_LISTING,
  parseStorageListingParams,
  storageListingSearch,
  type StorageListingParams,
} from "@beutl/core";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER_ID = "listing-user";

// The storage screen shows one page of files at a time and asks the server
// for each page by URL. The query scopes, filters, sorts, and pages in the
// database so an account near the paid file limit never crosses the wire.
describe("storage listing pages", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
  });

  function file(
    id: string,
    overrides: Partial<{
      name: string;
      size: number;
      mimeType: string;
      visibility: string;
      folderId: string | null;
      createdAt: Date;
      userId: string;
    }> = {},
  ) {
    memory.state.files.set(id, {
      id,
      userId: USER_ID,
      objectKey: id,
      name: id,
      size: 1,
      mimeType: "application/octet-stream",
      visibility: "PRIVATE",
      sha256: null,
      folderId: null,
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
      ...overrides,
    } as never);
  }

  const listing = (overrides: Partial<StorageListingParams> = {}): StorageListingParams => ({
    ...DEFAULT_STORAGE_LISTING,
    ...overrides,
  });

  it("lists only the folder asked for, newest first, and pages with a stable order", async () => {
    for (let index = 0; index < 30; index++) {
      file(`root-${index}`, { createdAt: new Date(10_000 + index) });
    }
    file("in-folder", { folderId: "folder-1", createdAt: new Date(99_999) });
    file("someone-elses", { userId: "other" });

    const first = await retrieveStorageFilesPage({
      userId: USER_ID,
      listing: listing(),
      pageSize: 24,
    });
    expect(first).toMatchObject({ total: 30, page: 1, pageCount: 2 });
    expect(first.files).toHaveLength(24);
    expect(first.files[0].id).toBe("root-29");

    const second = await retrieveStorageFilesPage({
      userId: USER_ID,
      listing: listing({ page: 2 }),
      pageSize: 24,
    });
    expect(second.files.map((row) => row.id)).toEqual(
      Array.from({ length: 6 }, (_, index) => `root-${5 - index}`),
    );

    const inFolder = await retrieveStorageFilesPage({
      userId: USER_ID,
      listing: listing({ folderId: "folder-1" }),
      pageSize: 24,
    });
    expect(inFolder.files.map((row) => row.id)).toEqual(["in-folder"]);
  });

  it("brings a page past the end back to the last one", async () => {
    file("only");
    const result = await retrieveStorageFilesPage({
      userId: USER_ID,
      listing: listing({ page: 9 }),
      pageSize: 24,
    });
    expect(result).toMatchObject({ total: 1, page: 1, pageCount: 1 });
    expect(result.files).toHaveLength(1);
  });

  it("searches every folder by name, ignoring case", async () => {
    file("Clip.mp4", { name: "Clip.mp4", folderId: "folder-1" });
    file("clip-notes.txt", { name: "clip-notes.txt" });
    file("render.png", { name: "render.png" });

    const result = await retrieveStorageFilesPage({
      userId: USER_ID,
      listing: listing({ folderId: "folder-9", query: "CLIP" }),
      pageSize: 24,
    });
    expect(result.files.map((row) => row.id).sort()).toEqual(["Clip.mp4", "clip-notes.txt"]);
  });

  it("filters by kind and visibility the way the screen classifies files", async () => {
    file("photo", { mimeType: "image/png" });
    file("movie", { mimeType: "video/mp4", visibility: "PUBLIC" });
    file("notes", { mimeType: "text/plain" });
    file("sheet", {
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    file("bundle", { mimeType: "application/zip" });
    file("blob", { mimeType: "application/octet-stream" });

    const ids = async (overrides: Partial<StorageListingParams>) =>
      (
        await retrieveStorageFilesPage({
          userId: USER_ID,
          listing: listing(overrides),
          pageSize: 24,
        })
      ).files
        .map((row) => row.id)
        .sort();

    expect(await ids({ kind: "image" })).toEqual(["photo"]);
    expect(await ids({ kind: "document" })).toEqual(["notes", "sheet"]);
    expect(await ids({ kind: "archive" })).toEqual(["bundle"]);
    expect(await ids({ kind: "other" })).toEqual(["blob"]);
    expect(await ids({ visibility: "PUBLIC" })).toEqual(["movie"]);
    expect(await ids({ kind: "video", visibility: "PRIVATE" })).toEqual([]);
  });

  it("sorts by name, size, or date in either direction", async () => {
    file("b", { name: "b", size: 3, createdAt: new Date(1) });
    file("a", { name: "a", size: 2, createdAt: new Date(2) });
    file("c", { name: "c", size: 1, createdAt: new Date(3) });

    const order = async (overrides: Partial<StorageListingParams>) =>
      (
        await retrieveStorageFilesPage({
          userId: USER_ID,
          listing: listing(overrides),
          pageSize: 24,
        })
      ).files.map((row) => row.id);

    expect(await order({ sort: "name", descending: false })).toEqual(["a", "b", "c"]);
    expect(await order({ sort: "size", descending: true })).toEqual(["b", "a", "c"]);
    expect(await order({ sort: "createdAt", descending: false })).toEqual(["b", "a", "c"]);
  });

  it("counts the files a folder deletion would take", async () => {
    file("one", { folderId: "f1" });
    file("two", { folderId: "f2" });
    file("root");
    file("not-mine", { folderId: "f1", userId: "other" });
    expect(await countStorageFilesInFolders({ userId: USER_ID, folderIds: ["f1", "f2"] })).toBe(2);
    expect(await countStorageFilesInFolders({ userId: USER_ID, folderIds: [] })).toBe(0);
  });
});

describe("storage listing URL", () => {
  it("round-trips every field and omits the defaults", () => {
    const params: StorageListingParams = {
      folderId: "folder-1",
      query: "clip",
      kind: "video",
      visibility: "PUBLIC",
      sort: "size",
      descending: false,
      page: 3,
    };
    const search = storageListingSearch(params);
    expect(parseStorageListingParams(new URLSearchParams(search))).toEqual(params);
    expect(storageListingSearch(DEFAULT_STORAGE_LISTING)).toBe("");
    // Name sorts ascending by default, so ascending is the omitted direction.
    expect(storageListingSearch({ ...DEFAULT_STORAGE_LISTING, sort: "name", descending: false })).toBe("?sort=name");
  });

  it("falls back to the defaults for values it does not know", () => {
    expect(
      parseStorageListingParams({ kind: "spreadsheet", sort: "colour", page: "-4", dir: "up" }),
    ).toEqual(DEFAULT_STORAGE_LISTING);
    expect(parseStorageListingParams({ page: ["2", "3"] }).page).toBe(2);
  });
});
