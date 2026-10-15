// The ESM build evaluates a bare `module` under Workers' nodejs_compat.
// Its CommonJS distribution keeps that Node detection inside a module wrapper.
import { unzipRaw } from "unzipit/dist/unzipit.js";
import type { Reader, ZipEntry } from "unzipit";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { normalizeNugetId, normalizeNugetVersion, type NugetMetadata } from "@beutl/core";
import type { ReleaseNugetData } from "@beutl/db";
import { getR2Bucket } from "../ai/r2-provider";

const METADATA_LIMIT = 2 * 1024 * 1024;
const DIRECTORY_LIMIT = 4 * 1024 * 1024;
export class InvalidNugetPackageError extends Error {}
const invalid = (message: string, cause?: unknown): never => { throw new InvalidNugetPackageError(message, { cause }); };
const text = (value: unknown): string => typeof value === "string" ? value : "";
const list = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];

export function parseNuspec(nuspec: string): NugetMetadata {
  if (nuspec.length > METADATA_LIMIT || /<!DOCTYPE|<!ENTITY/iu.test(nuspec) || XMLValidator.validate(nuspec) !== true) {
    return invalid("Invalid package manifest");
  }
  const m = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
    removeNSPrefix: true, processEntities: true }).parse(nuspec)?.package?.metadata;
  if (!m || typeof m !== "object") return invalid("Missing package metadata");
  const id = text(m.id), version = text(m.version);
  try { normalizeNugetId(id); normalizeNugetVersion(version); } catch (error) { return invalid("Invalid package ID or version", error); }
  if (!text(m.authors).trim() || !text(m.description).trim()) return invalid("Authors and description are required");
  const dependencies = (value: { "@_id"?: string; "@_version"?: string } | { "@_id"?: string; "@_version"?: string }[] | undefined) =>
    list(value).map((d) => {
      const id = text(d["@_id"]);
      try { normalizeNugetId(id); } catch (error) { return invalid("Invalid dependency ID", error); }
      return { id, range: text(d["@_version"]) || "(,)" };
    });
  const groups = list(m.dependencies?.group as { "@_targetFramework"?: string; dependency?: { "@_id"?: string; "@_version"?: string }[] } | undefined)
    .map((g) => ({ targetFramework: text(g["@_targetFramework"]), dependencies: dependencies(g.dependency) }));
  if (m.dependencies?.dependency) groups.unshift({ targetFramework: "", dependencies: dependencies(m.dependencies.dependency) });
  return {
    id, version, title: text(m.title) || id, authors: text(m.authors), description: text(m.description),
    summary: text(m.summary), tags: text(m.tags).split(/[\s,;]+/u).filter(Boolean),
    projectUrl: text(m.projectUrl), licenseUrl: text(m.licenseUrl), license: text(m.license?.["#text"]) || text(m.license),
    releaseNotes: text(m.releaseNotes), requireLicenseAcceptance: text(m.requireLicenseAcceptance).toLowerCase() === "true",
    icon: text(m.icon), iconUrl: text(m.iconUrl), readme: text(m.readme), dependencyGroups: groups,
    packageTypes: list(m.packageTypes?.packageType as { "@_name"?: string; "@_version"?: string } | undefined)
      .map((p) => ({ name: text(p["@_name"]), version: text(p["@_version"]) })),
    repository: { type: text(m.repository?.["@_type"]), url: text(m.repository?.["@_url"]),
      branch: text(m.repository?.["@_branch"]), commit: text(m.repository?.["@_commit"]) },
  };
}

export function blobReader(blob: Blob): Reader {
  return { getLength: async () => blob.size, read: async (offset, size) => new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer()) };
}

export function storedPackageReader(objectKey: string, size: number): Reader {
  return {
    getLength: async () => size,
    read: async (offset, length) => {
      const object = await getR2Bucket().get?.(objectKey, { range: { offset, length } });
      if (!object) throw new Error("Package object is missing");
      return new Uint8Array(object.arrayBuffer ? await object.arrayBuffer() : await new Response(object.body).arrayBuffer());
    },
  };
}

async function entriesOf(reader: Reader) {
  const length = await reader.getLength();
  const bounded: Reader = {
    getLength: async () => length,
    read: (offset, size) => {
      if (size > DIRECTORY_LIMIT || size < 0 || offset < 0 || offset + size > length) return invalid("Package directory is too large or invalid");
      return reader.read(offset, size);
    },
  };
  try {
    const { entries } = await unzipRaw(bounded);
    if (entries.length > 20000) return invalid("Too many package entries");
    const names = new Set<string>();
    for (const entry of entries) {
      const name = entry.name.replaceAll("\\", "/").toLowerCase();
      if (names.has(name)) return invalid("Duplicate package entry");
      names.add(name);
    }
    return entries;
  } catch (error) {
    if (error instanceof InvalidNugetPackageError) throw error;
    return invalid("Invalid NuGet ZIP archive", error);
  }
}

async function readEntry(entry: ZipEntry): Promise<ArrayBuffer> {
  if (entry.size > METADATA_LIMIT || entry.compressedSize > METADATA_LIMIT || entry.isDirectory) return invalid("Package metadata is too large");
  try {
    const bytes = await entry.arrayBuffer();
    if (bytes.byteLength !== entry.size) return invalid("Invalid package entry size");
    return bytes;
  } catch (error) { return invalid("Cannot read package metadata", error); }
}

export async function readNugetPackage(reader: Reader, expected?: { id: string; version: string }): Promise<ReleaseNugetData> {
  const entries = await entriesOf(reader);
  const manifests = entries.filter((e) => !e.name.includes("/") && !e.name.includes("\\") && e.name.toLowerCase().endsWith(".nuspec"));
  if (manifests.length !== 1) return invalid("The package must contain one root .nuspec manifest");
  const nuspec = new TextDecoder().decode(await readEntry(manifests[0]));
  const metadata = parseNuspec(nuspec);
  if (expected && (normalizeNugetId(expected.id) !== normalizeNugetId(metadata.id) ||
    normalizeNugetVersion(expected.version) !== normalizeNugetVersion(metadata.version))) return invalid("Package ID and version must match the release");
  const find = (path: string) => entries.find((e) => e.name.replaceAll("\\", "/").toLowerCase() === path.replaceAll("\\", "/").toLowerCase());
  const readme = metadata.readme ? find(metadata.readme) : null;
  if (metadata.readme && !readme) return invalid("Package readme is missing");
  if (metadata.icon && !find(metadata.icon)) return invalid("Package icon is missing");
  // Validate the embedded icon's bounded size at upload, without extracting other payloads.
  if (metadata.icon) await readEntry(find(metadata.icon)!);
  return { metadata, nuspec, readme: readme ? new TextDecoder().decode(await readEntry(readme)) : null };
}

export async function readNugetIcon(reader: Reader, path: string): Promise<ArrayBuffer | null> {
  const entry = (await entriesOf(reader)).find((e) => e.name.replaceAll("\\", "/").toLowerCase() === path.replaceAll("\\", "/").toLowerCase());
  return entry ? readEntry(entry) : null;
}
