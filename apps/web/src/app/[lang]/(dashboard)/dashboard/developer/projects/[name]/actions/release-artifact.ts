import "server-only";

import { blobReader, readNugetPackage } from "@beutl/api/nuget/archive";
import { getPackageType, type PackageAudience, type PackageType } from "@beutl/core";
import { getProfileByUserId, type ReleaseNugetData } from "@beutl/db";
import type { Translator } from "@beutl/i18n";
import { buildDataPackageNupkgFile } from "@/lib/data-package";
import type { StorageUploadFile } from "@/lib/storage";

export type ReleaseArtifact = {
  file: StorageUploadFile;
  nuget: ReleaseNugetData;
  packageType?: PackageType;
};

/** Prepare either upload format before entering the shared publication transaction. */
export async function prepareReleaseArtifact({ files, audience, id, version, title, description, user, t }: {
  files: File[];
  audience: PackageAudience;
  id: string;
  version: string;
  title: string;
  description: string;
  user: { id: string; name?: string | null };
  t: Translator;
}): Promise<{ ok: true; artifact: ReleaseArtifact } | { ok: false; message: string }> {
  if (files.length === 1 && files[0].name.toLowerCase().endsWith(".nupkg")) {
    const file = files[0];
    const nuget = await readNugetPackage(blobReader(file), { id, version });
    return {
      ok: true,
      artifact: { file, nuget, packageType: audience === "USER" ? "extension" : undefined },
    };
  }
  if (audience === "DEVELOPMENT") {
    return { ok: false, message: t("developer:nuget.nupkgRequired") };
  }

  const profile = await getProfileByUserId(user.id);
  const built = await buildDataPackageNupkgFile({
    files, id, version, title, description,
    username: profile?.userName || user.name || user.id,
    t,
  });
  if (!built.ok) return built;
  return {
    ok: true,
    artifact: { file: built.file, nuget: built.nuget, packageType: getPackageType(built.tags) },
  };
}
