export function desktopInstallUrl(packageName: string, version: string): string {
  return `beutl://install?package=${encodeURIComponent(packageName)}&version=${encodeURIComponent(version)}`;
}
