import "server-only";

import { contentPath } from "@/lib/content-url";
import type { retrieveDevPackagesByUserId } from "@beutl/db";
import { compareNugetVersions, type PackageAudience } from "@beutl/core";

export type Package = {
  id: string;
  audience: PackageAudience;
  name: string;
  displayName?: string;
  iconFileUrl?: string;
  latestVersion?: string;
  published: boolean;
  downloads: number;
};

type DevPackageRow = Awaited<
  ReturnType<typeof retrieveDevPackagesByUserId>
>[number];

// 開発者ポータルと概要ページが同じ整形を共有する。developer/actions.ts は
// "use server" なので同期関数を置けず、こちらに分けてある。
export function toPackages(rows: DevPackageRow[]): Package[] {
  return rows.map((pkg) => {
    // retrieveDevPackagesByUserId は Release に orderBy を持たないため、ここで
    // 降順に並べて先頭を最新版として扱う。
    const releases = [...pkg.Release].sort((a, b) =>
      compareNugetVersions(b.version, a.version),
    );
    return {
      id: pkg.id,
      audience: pkg.audience,
      name: pkg.name,
      displayName: pkg.displayName || undefined,
      iconFileUrl: (pkg.iconFile && contentPath(pkg.iconFile.id)) || undefined,
      latestVersion: releases[0]?.version,
      published: pkg.published,
      // 全バージョンの合計。非公開にしたリリースの分も含める。
      downloads: pkg.Release.reduce(
        (sum, release) => sum + Number(release.downloads),
        0,
      ),
    };
  });
}
