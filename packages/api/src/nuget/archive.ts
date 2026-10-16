// The ESM build evaluates a bare `module` under Workers' nodejs_compat.
// Its CommonJS distribution keeps that Node detection inside a module wrapper.
import { unzipRaw } from "unzipit/dist/unzipit.js";
import type { Reader, ZipEntry } from "unzipit";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { normalizeNugetId, normalizeNugetVersion, sanitizePayloadPath, type NugetMetadata } from "@beutl/core";
import type { ReleaseNugetData } from "@beutl/db";
import { getR2Bucket } from "../ai/r2-provider";
import { isValidNugetDependencyRange } from "./version-range";

const METADATA_LIMIT = 2 * 1024 * 1024;
const DIRECTORY_LIMIT = 4 * 1024 * 1024;
export class InvalidNugetPackageError extends Error {}
class NugetStorageReadError extends Error {}
const invalid = (message: string, cause?: unknown): never => { throw new InvalidNugetPackageError(message, { cause }); };
const text = (value: unknown): string => typeof value === "string" ? value : "";
const list = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];

function packageTypeVersion(value: string): boolean {
  // Package type versions use System.Version, not SemVer: two to four
  // non-negative Int32 components, allowing integer whitespace/signs.
  const parts = value.split(".");
  return parts.length >= 2 && parts.length <= 4 && parts.every((part) =>
    /^[+-]?\d+$/u.test(part.trim()) && Number(part) >= 0 && Number(part) <= 2147483647);
}

function validateMetadata(metadata: NugetMetadata): NugetMetadata {
  const limits = { title: 256, authors: 1024, description: 4000, summary: 4000,
    projectUrl: 2048, licenseUrl: 2048, license: 2048, releaseNotes: 35000,
    icon: 512, iconUrl: 2048, readme: 512 } as const;
  for (const [field, limit] of Object.entries(limits)) {
    if (metadata[field as keyof typeof limits].length > limit) invalid(`Package ${field} exceeds ${limit} characters`);
  }
  if (metadata.tags.length > 50 || metadata.tags.some((tag) => tag.length > 100)) invalid("Package tags exceed 50 entries or 100 characters per tag");
  if (metadata.dependencyGroups.length > 100 || metadata.dependencyGroups.reduce((sum, group) => sum + group.dependencies.length, 0) > 1000) {
    invalid("Too many package dependencies or target frameworks");
  }
  if (metadata.dependencyGroups.some((group) => group.targetFramework.length > 256 || group.dependencies.some((dependency) => dependency.range.length > 256))) {
    invalid("Package dependency range or target framework is too long");
  }
  if (metadata.packageTypes.length > 10 || metadata.packageTypes.some((type) => type.name.length > 100 || type.version.length > 128)) invalid("Invalid package types");
  if (Object.values(metadata.repository).some((value) => value.length > 2048)) invalid("Package repository metadata is too long");
  // Also bound the aggregate stored/returned metadata, including dependency lists.
  if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > 64 * 1024) invalid("Package metadata exceeds 64 KiB");
  return metadata;
}

export function parseNuspec(nuspec: string): NugetMetadata {
  if (nuspec.length > METADATA_LIMIT || /<!DOCTYPE|<!ENTITY/iu.test(nuspec) || XMLValidator.validate(nuspec) !== true) {
    return invalid("Invalid package manifest");
  }
  const m = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
    removeNSPrefix: true, processEntities: true }).parse(nuspec)?.package?.metadata;
  if (!m || typeof m !== "object") return invalid("Missing package metadata");
  const id = text(m.id), version = text(m.version);
  // The v prefix is compatible only with historical Web release records;
  // NuGet clients reject it inside the package manifest itself.
  if (version.startsWith("v")) return invalid("Invalid package ID or version");
  try { normalizeNugetId(id); normalizeNugetVersion(version); } catch (error) { return invalid("Invalid package ID or version", error); }
  if (!text(m.authors).trim() || !text(m.description).trim()) return invalid("Authors and description are required");
  const dependencies = (value: { "@_id"?: string; "@_version"?: string } | { "@_id"?: string; "@_version"?: string }[] | undefined) =>
    list(value).map((d) => {
      const id = text(d["@_id"]);
      try { normalizeNugetId(id); } catch (error) { return invalid("Invalid dependency ID", error); }
      const range = d["@_version"] === undefined ? "(, )" : text(d["@_version"]);
      if (!isValidNugetDependencyRange(range)) return invalid(`Invalid dependency version range for ${id}`);
      return { id, range };
    });
  const groups = list(m.dependencies?.group as { "@_targetFramework"?: string; dependency?: { "@_id"?: string; "@_version"?: string }[] } | undefined)
    .map((g) => ({ targetFramework: text(g["@_targetFramework"]), dependencies: dependencies(g.dependency) }));
  if (m.dependencies?.dependency) groups.unshift({ targetFramework: "", dependencies: dependencies(m.dependencies.dependency) });
  return validateMetadata({
    id, version, title: text(m.title) || id, authors: text(m.authors), description: text(m.description),
    summary: text(m.summary), tags: text(m.tags).split(/[\s,;]+/u).filter(Boolean),
    projectUrl: text(m.projectUrl), licenseUrl: text(m.licenseUrl), license: text(m.license?.["#text"]) || text(m.license),
    releaseNotes: text(m.releaseNotes), requireLicenseAcceptance: text(m.requireLicenseAcceptance).toLowerCase() === "true",
    icon: text(m.icon), iconUrl: text(m.iconUrl), readme: text(m.readme), dependencyGroups: groups,
    packageTypes: list(m.packageTypes?.packageType as { "@_name"?: string; "@_version"?: string } | undefined)
      .map((p) => {
        const name = text(p["@_name"]).trim(), version = text(p["@_version"]);
        try { normalizeNugetId(name); } catch (error) { return invalid("Invalid package type name", error); }
        if (p["@_version"] !== undefined && !packageTypeVersion(version)) return invalid("Invalid package type version");
        return { name, version };
      }),
    repository: { type: text(m.repository?.["@_type"]), url: text(m.repository?.["@_url"]),
      branch: text(m.repository?.["@_branch"]), commit: text(m.repository?.["@_commit"]) },
  });
}

export function blobReader(blob: Blob): Reader {
  return { getLength: async () => blob.size, read: async (offset, size) => new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer()) };
}

export function storedPackageReader(objectKey: string, size: number): Reader {
  return {
    getLength: async () => size,
    read: async (offset, length) => {
      try {
        const object = await getR2Bucket().get?.(objectKey, { range: { offset, length } });
        if (!object) throw new Error("Package object is missing");
        return new Uint8Array(object.arrayBuffer ? await object.arrayBuffer() : await new Response(object.body).arrayBuffer());
      } catch (cause) {
        // An unavailable object must be retried, not cached as an invalid ZIP.
        throw new NugetStorageReadError("Cannot read package storage", { cause });
      }
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
      // NuGet unescapes ZIP paths before extraction. Check that form too, on
      // both Windows and Unix, without allowing encoded traversal or roots.
      let name: string;
      try {
        name = decodeURIComponent(entry.name.replace(/%(?![0-9a-f]{2})/giu, "%25")).replaceAll("\\", "/");
        name = sanitizePayloadPath(entry.isDirectory ? name.replace(/\/$/u, "") : name);
      } catch (error) { return invalid("Unsafe package entry path", error); }
      name = name.toLowerCase();
      if (names.has(name)) return invalid("Duplicate package entry");
      names.add(name);
    }
    return entries;
  } catch (error) {
    if (error instanceof InvalidNugetPackageError || error instanceof NugetStorageReadError) throw error;
    return invalid("Invalid NuGet ZIP archive", error);
  }
}

async function readEntry(entry: ZipEntry): Promise<ArrayBuffer> {
  if (entry.size > METADATA_LIMIT || entry.compressedSize > METADATA_LIMIT || entry.isDirectory) return invalid("Package metadata is too large");
  try {
    const bytes = await entry.arrayBuffer();
    if (bytes.byteLength !== entry.size) return invalid("Invalid package entry size");
    return bytes;
  } catch (error) {
    if (error instanceof NugetStorageReadError) throw error;
    return invalid("Cannot read package metadata", error);
  }
}

function decodeNuspec(bytes: ArrayBuffer): string {
  const data = new Uint8Array(bytes);
  // XML's byte-order signature takes precedence over its encoding declaration.
  // Support Unicode manifests without silently substituting malformed bytes.
  const utf16le = data[0] === 0xff && data[1] === 0xfe || data[0] === 0x3c && data[1] === 0 && data[2] === 0x3f && data[3] === 0;
  const utf16be = data[0] === 0xfe && data[1] === 0xff || data[0] === 0 && data[1] === 0x3c && data[2] === 0 && data[3] === 0x3f;
  const encoding = utf16le ? "utf-16le" : utf16be ? "utf-16be" : "utf-8";
  if ((utf16le || utf16be) && data.length % 2) return invalid("Invalid package manifest encoding");
  let xml: string;
  try { xml = new TextDecoder(encoding, { fatal: true }).decode(data); }
  catch (error) { return invalid("Invalid package manifest encoding", error); }
  // workerd can preserve lone UTF-16 surrogates even in fatal mode. With the
  // Unicode flag this matches lone code units, not valid supplementary pairs.
  if (/[\uD800-\uDFFF]/u.test(xml)) return invalid("Invalid package manifest encoding");
  const declared = /^<\?xml\s[^?]*\bencoding\s*=\s*(["'])([^"']+)\1/iu.exec(xml)?.[2].toLowerCase();
  if (declared && declared !== encoding && !(declared === "utf-16" && (utf16le || utf16be))) {
    return invalid("Unsupported or mismatched package manifest encoding");
  }
  // The API serves this cached string as UTF-8, even for UTF-16 archives.
  return xml.replace(/^(<\?xml\s[^?]*\bencoding\s*=\s*)(["'])[^"']+\2/iu, '$1"utf-8"');
}

export async function readNugetPackage(reader: Reader, expected?: { id: string; version: string }): Promise<ReleaseNugetData> {
  const entries = await entriesOf(reader);
  const manifests = entries.filter((e) => !e.name.includes("/") && !e.name.includes("\\") && e.name.toLowerCase().endsWith(".nuspec"));
  if (manifests.length !== 1) return invalid("The package must contain one root .nuspec manifest");
  const nuspec = decodeNuspec(await readEntry(manifests[0]));
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
