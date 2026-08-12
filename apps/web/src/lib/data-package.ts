import "server-only";
import {
  buildNupkg,
  MATERIAL_TAG,
  rewriteTemplateReferences,
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

  const tags =
    materialFiles.length > 0 && templateFiles.length > 0
      ? [MATERIAL_TAG, TEMPLATE_TAG]
      : materialFiles.length > 0
        ? [MATERIAL_TAG]
        : [TEMPLATE_TAG];

  const nupkgFiles: NupkgFile[] = [];
  for (const file of materialFiles) {
    nupkgFiles.push({
      path: `materials/${file.name}`,
      data: new Uint8Array(await file.arrayBuffer()),
    });
  }
  for (const file of templateFiles) {
    const packagePath = `templates/${file.name}`;
    const json = new TextDecoder().decode(await file.arrayBuffer());
    const rewritten = rewriteTemplateReferences(
      json,
      packagePath,
      materialFiles.map((m) => ({
        packagePath: `materials/${m.name}`,
        basename: m.name,
      })),
      id,
    );
    nupkgFiles.push({
      path: packagePath,
      data: new TextEncoder().encode(rewritten),
    });
  }

  const nupkg = buildNupkg({
    id,
    version,
    title,
    description,
    tags,
    authors: username,
    files: nupkgFiles,
  });

  return {
    ok: true,
    file: new File([nupkg], `${id}.${version}.nupkg`, {
      type: "application/octet-stream",
    }),
    tags,
  };
}
