// @beutl/core: Next.js/Cloudflare に依存しない純粋ロジックの共有パッケージ。
// デスクトップ API (v1/v2/v3) と Web UI の両方から参照される。
export { selectPricing } from "./pricing";
export { formatAmount } from "./currency-formatter";
export { getRelativeTimeDifference } from "./relative-time";
export { isValidNuGetVersionRange } from "./nuget-version-range";
export { randomString, createHash } from "./create-hash";
export { cn, formatBytes } from "./utils";
export { STORAGE_QUOTA_BYTES } from "./storage-quota";
export type { ActionResult } from "./action-result";
export {
  isAllowedContinueUrlHost,
  resolveNativeAuthContinueTarget,
} from "./native-auth";
export { resolveSafeRedirectPath } from "./safe-redirect";
export { isAdmin } from "./admin-guard";
export { resolveContentAccess } from "./content-access";
export type {
  ContentAccessFile,
  ContentAccessResult,
} from "./content-access";
export {
  MATERIAL_TAG,
  TEMPLATE_TAG,
  RESERVED_PACKAGE_TAGS,
  PACKAGE_TYPES,
  PACKAGE_TYPE_FILTERS,
  isReservedPackageTag,
  isPackageType,
  isPackageTypeFilter,
  getPackageType,
  visiblePackageTags,
  applyPackageType,
  packageTypeWhere,
} from "./package-type";
export type {
  ReservedPackageTag,
  PackageType,
  PackageTypeFilter,
} from "./package-type";
export {
  buildNuspec,
  buildNupkg,
  sanitizePayloadPath,
  materialReferenceUri,
  rewriteTemplateReferences,
} from "./nupkg";
export type { NupkgFile, NupkgOptions } from "./nupkg";
