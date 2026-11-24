import { isGitRepositoryId, isGitRevision } from "@beutl/core";

export function desktopInstallUrl(packageName: string, version: string): string {
  return `beutl://install?package=${encodeURIComponent(packageName)}&version=${encodeURIComponent(version)}`;
}

export function desktopOpenRepositoryUrl(repositoryId: string, ref?: string | null): string {
  if (!isGitRepositoryId(repositoryId)) throw new Error("Invalid Git repository ID");

  const url = `beutl://repo/open?id=${encodeURIComponent(repositoryId)}`;
  return isGitRevision(ref) ? `${url}&ref=${encodeURIComponent(ref)}` : url;
}
