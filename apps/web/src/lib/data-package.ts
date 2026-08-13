import "server-only";
import {
  buildNupkg,
  MATERIAL_TAG,
  rewriteTemplateReferences,
  sanitizePayloadPath,
  TEMPLATE_TAG,
} from "@beutl/core";
import type { NupkgFile } from "@beutl/core";
import type { Translator } from "@beutl/i18n";

const MATERIAL_EXTENSIONS = [
  ".bmp", ".gif", ".ico", ".jpg", ".jpeg", ".png", ".webp", ".wbmp", ".avif", ".heif",
  ".wav", ".mp3", ".ogg", ".oga", ".flac", ".aac", ".m4a", ".opus",
  ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".wmv", ".mpg", ".mpeg",
  ".ttf", ".ttc", ".otf",
];

function extensionOf(name: string): string {
  return `.${name.split(".").pop()?.toLowerCase() ?? ""}`;
}

/**
 * Builds the nupkg a data-package release ships from the selected files, and the
 * reserved tags the package must carry. The kind follows the files: media files
 * land under `materials/`, JSON files under `templates/`, and a package carrying
 * both is tagged with both markers. Template JSONs get their `file://` references
 * to bundled materials rewritten to URIs relative to the template file.
 */
export async function buildDataPackageNupkgFile({
  files,
  id,
  version,
  title,
  description,
  username,
  t,
}: {
  files: File[];
  id: string;
  version: string;
  title: string;
  description: string;
  username: string;
  t: Translator;
}): Promise<{ ok: true; file: File; tags: string[] } | { ok: false; message: string }> {
  const materialFiles: File[] = [];
  const templateFiles: File[] = [];
  for (const file of files) {
    const ext = extensionOf(file.name);
    if (MATERIAL_EXTENSIONS.includes(ext)) {
      materialFiles.push(file);
    } else if (ext === ".json") {
      templateFiles.push(file);
    } else {
      return {
        ok: false,
        message: t("developer:upload.invalidFile", { name: file.name }),
      };
    }
  }
  if (materialFiles.length === 0 && templateFiles.length === 0) {
    return { ok: false, message: t("developer:upload.noFiles") };
  }

  // Two names differing only in case collide on a case-insensitive filesystem when the
  // package is installed, and among materials they also make a template reference — which
  // matches by name, case-insensitively — resolve to either file.
  for (const group of [materialFiles, templateFiles]) {
    const seen = new Set<string>();
    for (const file of group) {
      const key = file.name.toLowerCase();
      if (seen.has(key)) {
        return {
          ok: false,
          message: t("developer:upload.ambiguousFileName", { name: file.name }),
        };
      }
      seen.add(key);
    }
  }

  const tags =
    materialFiles.length > 0 && templateFiles.length > 0
      ? [MATERIAL_TAG, TEMPLATE_TAG]
      : materialFiles.length > 0
        ? [MATERIAL_TAG]
        : [TEMPLATE_TAG];

  // buildNupkg stores each entry at its sanitized path, so reference rewriting has to
  // work from the same value — a name holding a backslash lands in a subdirectory the
  // unsanitized path does not describe.
  let materialEntries: { packagePath: string; basename: string }[];
  try {
    materialEntries = materialFiles.map((m) => ({
      packagePath: sanitizePayloadPath(`materials/${m.name}`),
      basename: m.name,
    }));
  } catch {
    return { ok: false, message: t("developer:upload.invalidFileName") };
  }

  const nupkgFiles: NupkgFile[] = [];
  for (const [index, file] of materialFiles.entries()) {
    nupkgFiles.push({
      path: materialEntries[index].packagePath,
      data: new Uint8Array(await file.arrayBuffer()),
    });
  }
  for (const file of templateFiles) {
    let packagePath: string;
    let rewritten: string;
    try {
      packagePath = sanitizePayloadPath(`templates/${file.name}`);
      // A non-fatal decoder would replace malformed bytes with U+FFFD and package the
      // altered text, so bad input is rejected instead of silently rewritten.
      const json = new TextDecoder("utf-8", { fatal: true })
        .decode(await file.arrayBuffer());
      rewritten = rewriteTemplateReferences(json, packagePath, materialEntries, id);
    } catch {
      return {
        ok: false,
        message: t("developer:upload.invalidFile", { name: file.name }),
      };
    }
    nupkgFiles.push({
      path: packagePath,
      data: new TextEncoder().encode(rewritten),
    });
  }

  let nupkg: Uint8Array;
  try {
    nupkg = buildNupkg({
      id,
      version,
      title,
      description,
      tags,
      authors: username,
      files: nupkgFiles,
    });
  } catch {
    // sanitizePayloadPath rejects names a package cannot carry (e.g. a colon),
    // which are legal filenames on Unix.
    return { ok: false, message: t("developer:upload.invalidFileName") };
  }

  return {
    ok: true,
    file: new File([nupkg], `${id}.${version}.nupkg`, {
      type: "application/octet-stream",
    }),
    tags,
  };
}
