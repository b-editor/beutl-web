import { getContentUrl } from "../content-url";

export type MarketplaceReleaseResponseRecord = Readonly<{
  id: string;
  version: string;
  title: string;
  description: string;
  targetVersion: string;
  fileId: string | null;
  packageSha256?: string | null;
  // Optional keeps the mapper compatible with legacy records and test doubles
  // produced before the nullable database column existed.
  approvedAnalyticsManifestSha256?: string | null;
  file?: Readonly<{
    id: string;
    sha256: string | null;
  }> | null;
}>;

type ContentUrlResolver = (
  fileId: string | null | undefined,
  request?: Request,
) => Promise<string | null>;

export async function toMarketplaceReleaseResponse(
  release: MarketplaceReleaseResponseRecord,
  request?: Request,
  resolveContentUrl: ContentUrlResolver = getContentUrl,
) {
  const fileId = release.file?.id ?? release.fileId;
  const packageSha256 = release.file?.sha256 ?? null;
  const artifactMatches =
    release.file !== null &&
    release.file !== undefined &&
    release.file.id === release.fileId &&
    packageSha256 !== null &&
    packageSha256 === release.packageSha256;

  return {
    id: release.id,
    version: release.version,
    title: release.title,
    description: release.description,
    targetVersion: release.targetVersion,
    fileId,
    fileUrl: await resolveContentUrl(fileId, request),
    packageSha256,
    approvedAnalyticsManifestSha256: artifactMatches
      ? release.approvedAnalyticsManifestSha256 ?? null
      : null,
  };
}

/**
 * A file can theoretically be attached to more than one release. Expose an
 * approval only if every linked release agrees, so a stale legacy link can
 * never make a file appear approved by implication.
 */
export function resolveFileApprovedAnalyticsManifestSha256(
  packageSha256: string | null,
  releases: readonly Readonly<{
    packageSha256?: string | null;
    approvedAnalyticsManifestSha256?: string | null;
  }>[],
): string | null {
  if (!packageSha256 || releases.length === 0) {
    return null;
  }

  const approvals = new Set(
    releases.map((release) =>
      release.packageSha256 === packageSha256
        ? release.approvedAnalyticsManifestSha256 ?? null
        : null
    ),
  );
  if (approvals.size !== 1) {
    return null;
  }

  return [...approvals][0] ?? null;
}
