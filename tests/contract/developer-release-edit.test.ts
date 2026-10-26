import { zipSync, strToU8 } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEDICATED_STORAGE_TRANSACTION, setDbProvider } from "@beutl/db";
import { MATERIAL_TAG } from "@beutl/core";
import { setR2BucketProvider } from "@beutl/api/ai/r2-provider";
import { getTranslation } from "@beutl/i18n";
import { createDedicatedStorageFile } from "@/lib/storage";
import { blobReader, parseNuspec, readNugetPackage } from "../../packages/api/src/nuget/archive";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

vi.mock("@/lib/auth-guard", () => ({ authenticated: async (fn: (session: unknown) => unknown) => fn({ user: { id: "owner", name: "Owner" } }) }));
vi.mock("@beutl/next/language", () => ({ getLanguage: async () => "en" }));
vi.mock("@beutl/next/audit-log", () => ({ addAuditLog: async () => {}, auditLogActions: { developer: {} } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/storage", () => ({ createDedicatedStorageFile: vi.fn() }));
import { discardReleaseUpload, updateRelease } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/release";

const RELEASE_ID = "c7bc502e-aee6-4fbf-87f9-0c413659b1fe";
const manifest = '<package><metadata><id>Package</id><version>2.0.0</version><authors>Owner</authors><title>Latest SDK</title><description>Latest searchable description</description><tags>latest sdk</tags><projectUrl>https://sdk.example.test</projectUrl></metadata></package>';
describe("editing a release without replacing its artifact", () => {
  let row: {
    id: string; packageId: string; version: string; published: boolean;
    artifactLocked: boolean; package: { audience: "USER" | "DEVELOPMENT" };
    file: { id: string; userId: string; objectKey?: string; size?: bigint } | null;
    fileId: string | undefined; nugetListed: boolean; nugetMetadata: ReturnType<typeof parseNuspec> | null; nuspec: string;
  };
  let previousReleases: typeof row[];
  let update: ReturnType<typeof vi.fn>;
  let transaction: ReturnType<typeof vi.fn>;
  let beforeTransaction: (() => void) | undefined;
  let models: {
    profile: { findFirst: () => Promise<{ userName: string }> };
    publishedPackageVersion: { upsert: () => Promise<{ releaseId: string }> };
    release: { findUniqueOrThrow: () => Promise<unknown>; findMany: () => Promise<typeof row[]>; findFirst: () => Promise<typeof row>; findFirstOrThrow: () => Promise<typeof row>; update: ReturnType<typeof vi.fn> };
    package: { findUniqueOrThrow: () => Promise<{ name: string }>; findFirst: () => Promise<{ id: string; name: string; userId: string; tags: string[] }>; update: ReturnType<typeof vi.fn> };
    file: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  };
  beforeEach(() => {
    beforeTransaction = undefined;
    vi.mocked(createDedicatedStorageFile).mockReset();
    previousReleases = [];
    row = { id: RELEASE_ID, packageId: "pkg", version: "2.0.0", published: false, artifactLocked: false, package: { audience: "USER" }, file: { id: "existing-file", userId: "owner" },
      fileId: "existing-file", nugetListed: true, nugetMetadata: parseNuspec(manifest), nuspec: manifest };
    update = vi.fn(async ({ data }) => Object.assign(row, data));
    models = {
      profile: { findFirst: async () => ({ userName: "author" }) },
      publishedPackageVersion: { upsert: async () => ({ releaseId: RELEASE_ID }) },
      release: {
        findUniqueOrThrow: async () => ({ ...row, fileId: row.file?.id }),
        findMany: async () => [...previousReleases, row].filter((r) => r.published && r.nugetListed && r.fileId),
        findFirst: async () => ({ ...row }),
        findFirstOrThrow: async () => ({ ...row }),
        update,
      },
      package: {
        findUniqueOrThrow: async () => ({ id: "pkg", name: "Package", audience: row.package.audience, Release: [...previousReleases, { ...row }] }),
        findFirst: async () => ({ id: "pkg", name: "Package", userId: "owner", tags: [] }),
        update: vi.fn(async () => ({ name: "Package" })),
      },
      file: { findFirst: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    transaction = vi.fn(async (fn: (tx: typeof models) => unknown) => {
      beforeTransaction?.();
      return fn(models);
    });
    setDbProvider(async () => ({
      ...models,
      $transaction: transaction,
    }) as never);
  });
  function input(published: boolean) {
    const form = new FormData();
    form.set("id", RELEASE_ID);
    form.set("title", "Updated title");
    form.set("description", "Updated description");
    form.set("targetVersion", "2.0.0");
    form.set("published", published ? "on" : "off");
    return form;
  }
  it("retries a multipart attachment's write conflict with the extended commit timeout", async () => {
    row.file = null;
    const bytes = zipSync({ "Package.nuspec": strToU8(manifest) });
    models.file.findFirst.mockResolvedValue({ id: "uploaded", name: "package.nupkg", objectKey: "uploaded-key", size: BigInt(bytes.length) });
    setR2BucketProvider(() => ({ get: async (_key, options) => ({
      arrayBuffer: async () => bytes.slice(options.range.offset, options.range.offset + options.range.length).buffer,
    }) }) as never);
    transaction.mockRejectedValueOnce(Object.assign(new Error("write conflict"), { code: "P2034" }));
    const form = input(true); form.set("uploadedFileId", "uploaded");
    expect(await updateRelease(form)).toMatchObject({ success: true });
    expect(transaction).toHaveBeenCalledTimes(2);
    for (const call of transaction.mock.calls) expect(call[1]).toEqual(DEDICATED_STORAGE_TRANSACTION);
    expect(row).toMatchObject({ published: true, artifactLocked: true, fileId: "uploaded", nugetMetadata: parseNuspec(manifest) });
    expect(createDedicatedStorageFile).not.toHaveBeenCalled();
  });

  it.each(["unused", "attached", "other-owner", "missing"])("discards only an unused owned upload (%s)", async (state) => {
    const memory = createInMemoryPrisma();
    if (state !== "missing") memory.state.files.set("uploaded", { id: "uploaded", objectKey: "uploaded-key",
      userId: state === "other-owner" ? "another" : "owner", name: "package.nupkg", size: 7,
      mimeType: "application/octet-stream", visibility: state === "attached" ? "DEDICATED" : "PRIVATE" } as never);
    const find = memory.prisma.file.findFirst;
    memory.prisma.file.findFirst = async (args) => {
      const file = await find(args);
      return file && state === "attached" ? { ...file, Release: [{ id: RELEASE_ID }] } as never : file;
    };
    setDbProvider(async () => memory.prisma as never);
    await discardReleaseUpload("uploaded");
    expect(memory.state.files.has("uploaded")).toBe(state === "attached" || state === "other-owner");
    expect(memory.state.aiStorageCleanups.get("uploaded-key")?.state).toBe(state === "unused" ? "cleanup" : undefined);
  });
  it.each([true, false])("saves metadata and publication=%s while retaining the current file", async (published) => {
    const result = await updateRelease(input(published));
    expect(result.success).toBe(true);
    expect(row).toMatchObject({ title: "Updated title", published, fileId: "existing-file" });
    expect(models.package.update).not.toHaveBeenCalled();
  });
  it.each(["USER", "DEVELOPMENT"] as const)("validates and indexes the retained %s artifact before its first publication", async (audience) => {
    const bytes = zipSync({ "Package.nuspec": strToU8(manifest) });
    const get = vi.fn(async (_key, options) => ({
      arrayBuffer: async () => bytes.slice(options.range.offset, options.range.offset + options.range.length).buffer,
    }));
    setR2BucketProvider(() => ({ get }) as never);
    row.package.audience = audience; row.version = "v2.0.0";
    row.nugetMetadata = null; row.nuspec = "";
    row.file = { ...row.file!, objectKey: "retained", size: BigInt(bytes.length) };
    expect(await updateRelease(input(true))).toMatchObject({ success: true });
    expect(row).toMatchObject({ published: true, artifactLocked: true, nugetVersion: "2.0.0",
      fileId: "existing-file", nugetMetadata: parseNuspec(manifest), nuspec: manifest, nugetMetadataInvalid: false });
    const reads = get.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    expect(await updateRelease(input(false))).toMatchObject({ success: true });
    expect(await updateRelease(input(true))).toMatchObject({ success: true });
    expect(get).toHaveBeenCalledTimes(reads);
  });
  it.each([
    ["invalid archive", strToU8("not a ZIP")],
    ["wrong identity", zipSync({ "Package.nuspec": strToU8(manifest.replace("<id>Package</id>", "<id>Other</id>")) })],
    ["wrong version", zipSync({ "Package.nuspec": strToU8(manifest.replace("2.0.0", "1.0.0")) })],
  ])("leaves a retained draft editable when it has an %s", async (_, bytes) => {
    const get = vi.fn(async (_key, options) => ({
      arrayBuffer: async () => bytes.slice(options.range.offset, options.range.offset + options.range.length).buffer,
    }));
    setR2BucketProvider(() => ({ get }) as never);
    row.nugetMetadata = null; row.nuspec = "";
    row.file = { ...row.file!, objectKey: "retained", size: BigInt(bytes.length) };
    expect(await updateRelease(input(true))).toMatchObject({ success: false });
    expect(update).not.toHaveBeenCalled();
    expect(row).toMatchObject({ published: false, artifactLocked: false, fileId: "existing-file", nugetMetadata: null });
  });
  it("validates the retained file attached by the time the publication transaction begins", async () => {
    const bytes = zipSync({ "Package.nuspec": strToU8(manifest) });
    const get = vi.fn(async (_key, options) => ({
      arrayBuffer: async () => bytes.slice(options.range.offset, options.range.offset + options.range.length).buffer,
    }));
    setR2BucketProvider(() => ({ get }) as never);
    row.nugetMetadata = null; row.nuspec = "";
    beforeTransaction = () => { row.file = { id: "concurrent-file", userId: "owner", objectKey: "current-key", size: BigInt(bytes.length) }; };
    expect(await updateRelease(input(true))).toMatchObject({ success: true });
    expect(get.mock.calls.every(([key]) => key === "current-key")).toBe(true);
    expect(row).toMatchObject({ fileId: "concurrent-file", nugetMetadata: parseNuspec(manifest) });
  });
  it.each([true, false])("reindexes SDK metadata transactionally when publication becomes %s", async (published) => {
    row.package.audience = "DEVELOPMENT";
    row.published = !published;
    const older = { ...row, id: "older", version: "1.0.0", published: true,
      nugetMetadata: { ...row.nugetMetadata, title: "Older SDK", description: "Older description", tags: ["older"] } };
    previousReleases = [older];
    expect((await updateRelease(input(published))).success).toBe(true);
    const metadata = published ? row.nugetMetadata : older.nugetMetadata;
    expect(models.package.update).toHaveBeenCalledWith({ where: { id: "pkg" }, data: {
      displayName: metadata.title, description: metadata.description, shortDescription: metadata.description,
      tags: metadata.tags, webSite: metadata.projectUrl,
    } });
  });
  it("clears SDK search metadata when its last published release is hidden", async () => {
    row.package.audience = "DEVELOPMENT"; row.published = true;
    expect((await updateRelease(input(false))).success).toBe(true);
    expect(models.package.update).toHaveBeenCalledWith({ where: { id: "pkg" }, data: {
      displayName: null, description: "", shortDescription: "", tags: [], webSite: "",
    } });
  });
  it("indexes the uploaded SDK nuspec on publication and keeps drafts out of search", async () => {
    row.package.audience = "DEVELOPMENT"; row.file = null;
    const file = { id: "replacement-file", objectKey: "replacement-key", size: 7n };
    vi.mocked(createDedicatedStorageFile).mockImplementation(async ({ publish }) => {
      await publish?.(models as never, file);
      return { kind: "created", record: file } as never;
    });
    const form = input(false);
    form.append("file", new File([zipSync({ "Package.nuspec": strToU8(manifest.replace("Latest SDK", "Uploaded SDK")) })], "package.nupkg"));
    expect((await updateRelease(form)).success).toBe(true);
    expect(models.package.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ displayName: null }) }));
    row.file = { id: file.id, userId: "owner" };
    expect((await updateRelease(input(true))).success).toBe(true);
    expect(models.package.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: {
      displayName: "Uploaded SDK", description: "Latest searchable description", shortDescription: "Latest searchable description",
      tags: ["latest", "sdk"], webSite: "https://sdk.example.test",
    } }));
  });
  it("allows editing a draft before uploading its first file", async () => {
    row.file = null;
    expect((await updateRelease(input(false))).success).toBe(true);
  });
  it("does not publish an artifact-free draft when the file field becomes optional", async () => {
    row.file = null;
    expect((await updateRelease(input(true))).success).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(row.published).toBe(false);
  });
  it("rejects publication with a localized error if the file disappeared before the transaction", async () => {
    beforeTransaction = () => { row.file = null; };
    const { t } = await getTranslation("en");
    await expect(updateRelease(input(true))).resolves.toMatchObject({
      success: false, message: t("developer:errors.fileNotFound"),
    });
    expect(update).not.toHaveBeenCalled();
    expect(row.published).toBe(false);
  });
  it("accepts a file attached after the initial snapshot but before the transaction", async () => {
    row.file = null;
    beforeTransaction = () => { row.file = { id: "concurrent-file", userId: "owner" }; };
    expect((await updateRelease(input(true))).success).toBe(true);
    expect(row).toMatchObject({ published: true, fileId: "concurrent-file" });
  });
  it("can publish a new uploaded artifact when no existing file remains", async () => {
    row.file = null;
    const file = { id: "replacement-file", objectKey: "replacement-key", size: 7n };
    vi.mocked(createDedicatedStorageFile).mockImplementation(async ({ publish }) => {
      await publish?.(models as never, file);
      return { kind: "created", record: file } as never;
    });
    const form = input(true);
    form.append("file", new File([zipSync({ "Package.nuspec": strToU8("<package><metadata><id>Package</id><version>2.0.0</version><authors>Owner</authors><description>Package</description></metadata></package>") })], "package.nupkg"));
    expect((await updateRelease(form)).success).toBe(true);
    expect(row).toMatchObject({ published: true, fileId: file.id });
  });
  it.each([true, false])("refuses replacing a previously published file while published=%s", async (published) => {
    row.artifactLocked = true; row.published = published;
    const form = input(published); form.append("file", new File(["replacement"], "package.nupkg"));
    expect((await updateRelease(form)).success).toBe(false);
    expect(createDedicatedStorageFile).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it("publishes data uploads through the same transaction and preserves concurrent custom tags", async () => {
    row.file = null;
    const record = { id: "data-file", objectKey: "data-key", size: 7n };
    vi.mocked(createDedicatedStorageFile).mockImplementation(async ({ file, publish }) => {
      const blob = await new Response(file.stream()).blob();
      const metadata = await readNugetPackage(blobReader(blob));
      expect(metadata.metadata).toMatchObject({ id: "Package", version: "2.0.0", authors: "author" });
      models.package.findFirst = async () => ({ id: "pkg", name: "Package", userId: "owner", tags: ["edited-during-upload"] });
      await publish?.(models as never, record);
      return { kind: "created", record } as never;
    });
    const form = input(true);
    form.append("file", new File(["image"], "image.png"));
    expect(await updateRelease(form)).toMatchObject({ success: true });
    expect(createDedicatedStorageFile).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ published: true, fileId: record.id, artifactLocked: true });
    expect(models.package.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { tags: expect.arrayContaining(["edited-during-upload", MATERIAL_TAG]) },
    }));
  });
  it("rejects data uploads for SDK packages before storage", async () => {
    row.package.audience = "DEVELOPMENT";
    const form = input(true);
    form.append("file", new File(["image"], "image.png"));
    const { t } = await getTranslation("en");
    expect(await updateRelease(form)).toMatchObject({ success: false, message: t("developer:nuget.nupkgRequired") });
    expect(createDedicatedStorageFile).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it("rechecks the lock after an upload races with publication", async () => {
    const file = { id: "replacement-file", objectKey: "replacement-key", size: 7n };
    vi.mocked(createDedicatedStorageFile).mockImplementation(async ({ publish }) => {
      row.artifactLocked = true; row.published = true;
      await publish?.(models as never, file);
      return { kind: "created", record: file } as never;
    });
    const form = input(true);
    form.append("file", new File([zipSync({ "Package.nuspec": strToU8("<package><metadata><id>Package</id><version>2.0.0</version><authors>Owner</authors><description>Package</description></metadata></package>") })], "package.nupkg"));
    expect((await updateRelease(form)).success).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

});
