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

export type DataPackageType = "material" | "template" | "both";

function extensionOf(name: string): string {
  return `.${name.split(".").pop()?.toLowerCase() ?? ""}`;
}

/**
 * Builds the nupkg a data-package release ships from an uploaded folder, and the
 * reserved tags the package must carry. For "both" the folder has to contain
 * `materials/` and `templates/` subdirectories; template JSONs get their `file://`
 * references to bundled materials rewritten to URIs relative to the template file.
 */
export async function buildDataPackageNupkgFile({
  type,
  files,
  id,
  version,
  title,
  description,
  username,
  t,
}: {
  type: DataPackageType;
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
    const first = file.name.split("/")[0];
    if (type === "both") {
      if (first === "materials") materialFiles.push(file);
      else if (first === "templates") templateFiles.push(file);
      else {
        return {
          ok: false,
          message: t("developer:upload.invalidFile", { name: file.name }),
        };
      }
    } else if (type === "material") {
      materialFiles.push(file);
    } else {
      templateFiles.push(file);
    }
  }
  if (materialFiles.length === 0 && templateFiles.length === 0) {
    return { ok: false, message: t("developer:upload.noFiles") };
  }

  for (const file of materialFiles) {
    if (!MATERIAL_EXTENSIONS.includes(extensionOf(file.name))) {
      return {
        ok: false,
        message: t("developer:upload.invalidFile", { name: file.name }),
      };
    }
  }
  for (const file of templateFiles) {
    if (extensionOf(file.name) !== ".json") {
      return {
        ok: false,
        message: t("developer:upload.invalidFile", { name: file.name }),
      };
    }
  }

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
        basename: m.name.split("/").pop() ?? m.name,
      })),
      id,
    );
    nupkgFiles.push({
      path: packagePath,
      data: new TextEncoder().encode(rewritten),
    });
  }

  const tags =
    type === "both"
      ? [MATERIAL_TAG, TEMPLATE_TAG]
      : [type === "material" ? MATERIAL_TAG : TEMPLATE_TAG];

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
