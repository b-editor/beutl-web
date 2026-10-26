import { assertPackageIdNotReserved, packageNameFilter, nugetSearchableMetadata } from "@beutl/db";
import { boundedBody, compareNugetVersions, normalizeNugetId, normalizeNugetVersion } from "@beutl/core";
import { createRelease, getDb, ReleaseIdentityConflictError, updateRelease, type PrismaTransaction } from "@beutl/db";
import { createStorageOperations } from "../storage/files";
import { blobReader, InvalidNugetPackageError, readNugetPackage } from "./archive";

// Cloudflare accepts at most 100 MB in a request body on the Free and Pro
// plans. Leave room for the multipart envelope and stay below that ceiling.
export const NUGET_PUSH_LIMIT = 90 * 1024 * 1024;
export class NugetPushTooLargeError extends Error {}
export class NugetOwnershipError extends Error {}
export class NugetPackageUnpublishedError extends Error {}

/** NuGet sends the archive in the first multipart part; its name/filename are immaterial. */
export async function readPushBody(request: Request): Promise<Blob> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > NUGET_PUSH_LIMIT + 65536)) {
    await request.body?.cancel(); throw new NugetPushTooLargeError();
  }
  if (!request.body) throw new InvalidNugetPackageError("Missing package");
  let exceeded = false;
  let body: Blob;
  try { body = await new Response(boundedBody(request.body, NUGET_PUSH_LIMIT + 65536, () => { exceeded = true; })).blob(); }
  catch (error) { if (exceeded) throw new NugetPushTooLargeError(); throw error; }
  const type = request.headers.get("content-type") ?? "";
  if (/^multipart\/form-data\b/iu.test(type)) {
    const boundary = /boundary=(?:"([^"\r\n]+)"|([^;\s]+))/iu.exec(type);
    const value = boundary?.[1] ?? boundary?.[2];
    if (!value || value.length > 200) throw new InvalidNugetPackageError("Invalid multipart boundary");
    const first = Buffer.from(await body.slice(0, 16384).arrayBuffer());
    const prefix = `--${value}\r\n`;
    const start = first.indexOf("\r\n\r\n");
    if (!first.subarray(0, prefix.length).equals(Buffer.from(prefix)) || start < prefix.length) throw new InvalidNugetPackageError("Invalid multipart header");
    const marker = Buffer.from(`\r\n--${value}`);
    // Search in bounded chunks rather than duplicating the entire archive in JS memory.
    let end = -1;
    for (let offset = start + 4; offset < body.size; offset += 65536) {
      const chunk = Buffer.from(await body.slice(offset, offset + 65536 + marker.length + 2).arrayBuffer());
      let at = chunk.indexOf(marker);
      while (at >= 0) {
        const suffix = chunk.subarray(at + marker.length, at + marker.length + 2).toString();
        if (suffix === "--" || suffix === "\r\n") { end = offset + at; break; }
        at = chunk.indexOf(marker, at + 1);
      }
      if (end >= 0) break;
    }
    if (end < 0) throw new InvalidNugetPackageError("Incomplete multipart package");
    body = body.slice(start + 4, end);
  }
  if (body.size > NUGET_PUSH_LIMIT) throw new NugetPushTooLargeError();
  return body;
}

async function checkIdentity(tx: PrismaTransaction, name: string, version: string, userId: string) {
  const pkg = await tx.package.findFirst({ where: { name: packageNameFilter(name) }, include: { Release: { orderBy: { createdAt: "desc" }, select: { version: true, targetVersion: true, published: true, nugetListed: true } } } });
  if (pkg && pkg.userId !== userId) throw new NugetOwnershipError();
  if (pkg && !pkg.published) throw new NugetPackageUnpublishedError("Publish the project before pushing a package version.");
  if (!pkg) await assertPackageIdNotReserved(tx, name);
  if (pkg?.Release.some((r) => normalizeNugetVersion(r.version) === version) ||
    await tx.publishedPackageVersion.findUnique({ where: { name_version: { name, version } } })) throw new ReleaseIdentityConflictError();
  return pkg;
}

export async function pushNugetPackage(request: Request, userId: string, execution?: Parameters<typeof createStorageOperations>[0]) {
  const body = await readPushBody(request);
  const nuget = await readNugetPackage(blobReader(body));
  const { metadata } = nuget;
  const name = normalizeNugetId(metadata.id), version = normalizeNugetVersion(metadata.version);
  await checkIdentity(await getDb(), name, version, userId);
  const file = new File([body], `${name}.${version}.nupkg`, { type: "application/octet-stream" });
  const result = await createStorageOperations(execution).createDedicatedStorageFile({ file, userId,
    publish: async (tx, record) => {
      let pkg = await checkIdentity(tx, name, version, userId);
      const searchable = nugetSearchableMetadata(metadata);
      if (pkg?.audience === "DEVELOPMENT" && pkg.Release.every((release) =>
        !release.published || !release.nugetListed || compareNugetVersions(version, release.version) > 0)) {
        await tx.package.update({ where: { id: pkg.id }, data: searchable });
      }
      // Creating an ID by CLI creates a development library. User packages are created in the dashboard.
      pkg ??= await tx.package.create({ data: { name: metadata.id, userId, audience: "DEVELOPMENT", published: true,
        ...searchable }, include: { Release: { orderBy: { createdAt: "desc" }, select: { version: true, targetVersion: true, published: true, nugetListed: true } } } });
      const targetVersion = pkg.audience === "USER"
        ? pkg.Release.find((r) => r.targetVersion)?.targetVersion || "1.0.0-preview.10"
        : "";
      const release = await createRelease({ packageId: pkg.id, version: metadata.version, title: metadata.title,
        description: metadata.releaseNotes, targetVersion, published: false, prisma: tx });
      await updateRelease({ id: release.id, title: metadata.title, description: metadata.releaseNotes,
        targetVersion, published: true, fileId: record.id, nuget, prisma: tx });
    },
  });
  return result;
}
