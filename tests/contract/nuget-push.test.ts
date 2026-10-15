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
  publishedPackageVersion: { findUnique: vi.fn(async () => null) },
};
const existing = { id: "pkg", userId: "owner", audience: "DEVELOPMENT", Release: [
  { version: "1.0.0", targetVersion: "", published: true, nugetListed: true },
] };

beforeEach(() => {
  vi.clearAllMocks();
  tx.package.findFirst.mockResolvedValue(existing);
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
