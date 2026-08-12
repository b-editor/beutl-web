// Builds a NuGet package (.nupkg) from a payload directory. The desktop client
// installs data packages through the NuGet pipeline, so the zip has to carry a root
// nuspec plus the payload under `materials/` or `templates/` — the layout
// `PackageFolderReader` reads after extraction.

import { strToU8, zipSync } from "fflate";

export type NupkgFile = {
  /** Path within the package, e.g. `materials/logo.png` or `templates/title.json`. */
  path: string;
  data: Uint8Array;
};

export type NupkgOptions = {
  id: string;
  version: string;
  title: string;
  description: string;
  tags: string[];
  authors: string;
  files: NupkgFile[];
};

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildNuspec({
  id,
  version,
  title,
  description,
  tags,
  authors,
}: NupkgOptions): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>${escapeXml(id)}</id>
    <version>${escapeXml(version)}</version>
    <title>${escapeXml(title)}</title>
    <authors>${escapeXml(authors)}</authors>
    <description>${escapeXml(description)}</description>
    <tags>${escapeXml(tags.join(" "))}</tags>
  </metadata>
</package>
`;
}

/**
 * Sanitizes a payload-relative path so it cannot escape the package: no absolute
 * paths, no `..`, no backslashes, and no empty segments.
 */
export function sanitizePayloadPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    segments.some(
      (s) => s === "" || s === "." || s === ".." || s.includes(":"),
    )
  ) {
    throw new Error(`Invalid payload path: ${path}`);
  }
  return segments.join("/");
}

export function buildNupkg(options: NupkgOptions): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    [`${options.id}.${options.version}.nuspec`]: strToU8(buildNuspec(options)),
  };

  for (const file of options.files) {
    const path = sanitizePayloadPath(file.path);
    entries[path] = file.data;
  }

  return zipSync(entries);
}

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s !== "" && s !== ".");
}

function relativePath(fromDir: string, toPath: string): string {
  const from = splitPath(fromDir);
  const to = splitPath(toPath);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common++;
  }
  const ups = from.length - common;
  const downs = to.slice(common);
  return [...Array(ups).fill(".."), ...downs].join("/");
}

/**
 * The URI a template file uses to reach a bundled material after installation.
 * The install layout is `{home}/templates/{package}/...` and
 * `{home}/materials/{package}/...`, so the `{home}` prefix cancels out of the
 * relative path and the result is portable across machines.
 */
export function materialReferenceUri(
  templatePackagePath: string,
  materialPackagePath: string,
  packageId: string,
): string {
  const subdir = splitPath(templatePackagePath).slice(0, -1).join("/").replace(/^templates\/?/, "");
  const templateDir = `templates/${packageId}${subdir ? `/${subdir}` : ""}`;
  const materialPath = `materials/${packageId}/${materialPackagePath.replace(/^materials\//, "")}`;
  return encodeUriPath(relativePath(templateDir, materialPath));
}

// A legal file name can hold characters a URI reads as syntax — `logo#dark.png`
// would truncate at the fragment — so every segment except `..` is escaped.
function encodeUriPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment === ".." ? segment : encodeURIComponent(segment)))
    .join("/");
}

/**
 * Rewrites `file://` references in a template JSON that point at bundled
 * materials into URIs relative to the template file, so the reference survives
 * installation on another machine. Matching is by file name.
 */
export function rewriteTemplateReferences(
  json: string,
  templatePackagePath: string,
  materials: { packagePath: string; basename: string }[],
  packageId: string,
): string {
  const byBasename = new Map<string, string>();
  for (const m of materials) {
    const key = m.basename.toLowerCase();
    if (byBasename.has(key)) {
      // Matching is case-insensitive, so `Logo.png` and `logo.png` would both claim this
      // key and a reference to either could resolve to the wrong file.
      throw new Error(`Ambiguous material file name: ${m.basename}`);
    }
    byBasename.set(key, m.packagePath);
  }

  // Rewriting string tokens in place keeps every other byte — notably integers outside
  // JS's safe range, which a JSON.parse/stringify round trip would silently round.
  return json.replace(JSON_STRING_TOKEN, (token) => {
    let value: string;
    try {
      value = JSON.parse(token) as string;
    } catch {
      return token;
    }
    if (!value.startsWith("file://")) return token;

    const basename = decodeURIComponent(value.split("/").pop() ?? "").toLowerCase();
    const materialPath = byBasename.get(basename);
    if (!materialPath) return token;

    return JSON.stringify(
      materialReferenceUri(templatePackagePath, materialPath, packageId),
    );
  });
}

// A complete JSON string literal, including escapes, so a `file://` value is replaced
// without touching the numbers around it.
const JSON_STRING_TOKEN = /"(?:[^"\\]|\\.)*"/g;
