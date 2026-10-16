import { beforeEach, describe, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { setDbProvider } from "@beutl/db";
import { pushNugetPackage } from "../../packages/api/src/nuget/push";

const publication = vi.hoisted(() => ({ createRelease: vi.fn(), updateRelease: vi.fn(), store: vi.fn() }));
vi.mock("@beutl/db", async (original) => ({ ...await original<typeof import("@beutl/db")>(),
  createRelease: publication.createRelease, updateRelease: publication.updateRelease,
}));
vi.mock("../../packages/api/src/storage/files", () => ({
  createStorageOperations: () => ({ createDedicatedStorageFile: publication.store }),
}));

const tx = {
  package: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  publishedPackageVersion: { findUnique: vi.fn(async () => null), findFirst: vi.fn() },
};
const existing = { id: "pkg", userId: "owner", audience: "DEVELOPMENT", published: true, Release: [
  { version: "1.0.0", targetVersion: "", published: true, nugetListed: true },
] };

beforeEach(() => {
  vi.clearAllMocks();
  tx.package.findFirst.mockResolvedValue(existing);
  tx.publishedPackageVersion.findFirst.mockResolvedValue(null);
  tx.package.create.mockResolvedValue({ ...existing, Release: [] });
  setDbProvider(async () => tx as never);
  publication.createRelease.mockResolvedValue({ id: "new-release" });
  publication.store.mockImplementation(async ({ publish }) => {
    await publish(tx, { id: "uploaded-file" });
    return { kind: "created" };
  });
});

async function push(version = "2.0.0") {
  const nuspec = `<package><metadata><id>Library</id><version>${version}</version><title>New title</title>
    <authors>Author</authors><description>New searchable description</description><summary>New summary</summary>
    <tags>newtag sdk</tags><projectUrl>https://example.test/new</projectUrl></metadata></package>`;
  return pushNugetPackage(new Request("https://nuget.example/api/v2/package", {
    method: "PUT", body: new Blob([zipSync({ "Library.nuspec": strToU8(nuspec) })]),
  }), "owner");
}

describe("NuGet push searchable metadata", () => {
  it("rejects invalid manifest bytes before reserving an identity or storing the package", async () => {
    const bytes = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="utf-8"?><package><metadata><id>Library</id><version>2.0.0</version><authors>Author</authors><description>'),
      Buffer.from([0xc3, 0x28]), Buffer.from('</description></metadata></package>')]);
    const request = new Request("https://nuget.example/api/v2/package", {
      method: "PUT", body: new Blob([zipSync({ "Library.nuspec": bytes })]),
    });
    await expect(pushNugetPackage(request, "owner")).rejects.toThrow("Invalid package manifest encoding");
    expect(tx.package.findFirst).not.toHaveBeenCalled();
    expect(publication.store).not.toHaveBeenCalled();
  });
  it.each(["USER", "DEVELOPMENT"])("rejects a hidden %s project before storing bytes", async (audience) => {
    tx.package.findFirst.mockResolvedValue({ ...existing, audience, published: false });
    await expect(push()).rejects.toThrow("Publish the project before pushing");
    expect(publication.store).not.toHaveBeenCalled();
    expect(publication.createRelease).not.toHaveBeenCalled();
  });
  it("rechecks project visibility in the publication transaction", async () => {
    tx.package.findFirst.mockResolvedValueOnce(existing).mockResolvedValueOnce({ ...existing, published: false });
    await expect(push()).rejects.toThrow("Publish the project before pushing");
    expect(publication.createRelease).not.toHaveBeenCalled();
  });
  it("rejects another version of a deleted published ID before storing bytes", async () => {
    tx.package.findFirst.mockResolvedValue(null);
    tx.publishedPackageVersion.findFirst.mockResolvedValue({ name: "library" });
    await expect(push("3.0.0")).rejects.toThrow("permanently reserved");
    expect(publication.store).not.toHaveBeenCalled();
    expect(tx.package.create).not.toHaveBeenCalled();
  });
  it("rechecks ID reservations in the publication transaction", async () => {
    tx.package.findFirst.mockResolvedValue(null);
    tx.publishedPackageVersion.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ name: "library" });
    await expect(push()).rejects.toThrow("permanently reserved");
    expect(tx.package.create).not.toHaveBeenCalled();
  });
  it("refreshes an existing SDK's searchable fields in the publication transaction", async () => {
    await expect(push()).resolves.toEqual({ kind: "created" });
    expect(tx.package.update).toHaveBeenCalledWith({ where: { id: "pkg" }, data: {
      displayName: "New title", description: "New searchable description", shortDescription: "New summary",
      tags: ["newtag", "sdk"], webSite: "https://example.test/new",
    } });
    expect(publication.updateRelease).toHaveBeenCalledWith(expect.objectContaining({ published: true, prisma: tx }));
  });
  it("does not replace newer searchable metadata when pushing an older SDK version", async () => {
    await push("0.9.0");
    expect(tx.package.update).not.toHaveBeenCalled();
    expect(publication.updateRelease).toHaveBeenCalled();
  });
  it("preserves user package descriptions managed through the dashboard", async () => {
    tx.package.findFirst.mockResolvedValueOnce({ ...existing, audience: "USER" }).mockResolvedValueOnce({ ...existing, audience: "USER" });
    await push();
    expect(tx.package.update).not.toHaveBeenCalled();
  });
});
