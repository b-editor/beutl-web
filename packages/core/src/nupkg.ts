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

// XML 1.0 has no representation at all for most C0 controls, unpaired surrogates, or
// U+FFFE/U+FFFF — not even an escape — so a nuspec carrying one is rejected by NuGet's
// reader at install time rather than at upload.
function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

function escapeXml(value: string): string {
  // Iterating by code point pairs surrogates, so a lone one falls outside every range.
  for (const ch of value) {
    if (!isXmlChar(ch.codePointAt(0)!)) {
      throw new Error("Metadata contains a character XML 1.0 cannot represent.");
    }
  }

  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// NuGet's package-id rule: word characters at both ends, single `.`/`-`/`_` separators
// between them. `.abc`, `abc.`, and `a..b` are all rejected at install time.
const NUGET_PACKAGE_ID = /^\w+(?:[.\-_]\w+)*$/;

export function buildNuspec({
  id,
  version,
  title,
  description,
  tags,
  authors,
}: NupkgOptions): string {
  // NuGet requires these, and a consumer validating the manifest rejects the package
  // rather than installing it.
  for (const [field, value] of Object.entries({ id, version, description, authors })) {
    if (value.trim() === "") {
      throw new Error(`Package metadata is missing a required field: ${field}.`);
    }
  }

  if (!NUGET_PACKAGE_ID.test(id)) {
    throw new Error(`'${id}' is not a usable NuGet package id.`);
  }

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

// Names Windows refuses regardless of extension, so `aux.png` is rejected too.
const WINDOWS_RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

// A segment Windows cannot create: a reserved character, a C0 control, a trailing dot
// or space, or a reserved device name.
function isWindowsHostileSegment(segment: string): boolean {
  for (const ch of segment) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || '<>:"|?*'.includes(ch)) return true;
  }

  if (segment.endsWith(".") || segment.endsWith(" ")) return true;

  // Windows reads the superscript digits as 1-3, so `COM¹` names the same device as
  // `COM1`.
  const stem = segment
    .split(".")[0]
    .toLowerCase()
    .replaceAll("¹", "1")
    .replaceAll("²", "2")
    .replaceAll("³", "3");
  return WINDOWS_RESERVED_NAMES.has(stem);
}

/**
 * Sanitizes a payload-relative path so it cannot escape the package and can be
 * extracted on every platform Beutl runs on: no absolute paths, no `..`, no
 * backslashes, no empty segments, and nothing Windows refuses to create.
 */
export function sanitizePayloadPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    segments.some(
      (s) => s === "" || s === "." || s === ".." || isWindowsHostileSegment(s),
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

  // Token replacement only reads the string literals, so the document is validated here
  // — a template broken outside a string would otherwise be packaged unchanged.
  JSON.parse(json);

  // Rewriting string tokens in place keeps every other byte — notably integers outside
  // JS's safe range, which a JSON.parse/stringify round trip would silently round.
  return json.replace(JSON_STRING_TOKEN, (token) => {
    let value: string;
    try {
      value = JSON.parse(token) as string;
    } catch {
      return token;
    }
    // URI schemes are case-insensitive, so `FILE://` names the same thing.
    if (!value.toLowerCase().startsWith("file://")) return token;

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
