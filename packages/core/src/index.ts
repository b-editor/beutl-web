// @beutl/core: Next.js/Cloudflare に依存しない純粋ロジックの共有パッケージ。
// デスクトップ API (v1/v2/v3) と Web UI の両方から参照される。
export { selectPricing } from "./pricing";
export { formatAmount } from "./currency-formatter";
export { getRelativeTimeDifference } from "./relative-time";
export { isValidNuGetVersionRange } from "./nuget-version-range";
export { randomString, createHash } from "./create-hash";
export { cn, formatBytes } from "./utils";
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
  analyticsManifestV1MaxBytes,
  analyticsManifestV1MaxFeatures,
  analyticsManifestV1MaxTypeIdentifierCharacters,
  analyticsManifestV1MaxTypesPerFeature,
  analyticsManifestV1Path,
  AnalyticsManifestValidationError,
  parseAnalyticsManifestV1,
  parseAnalyticsManifestV1Json,
} from "./analytics-manifest";
export type {
  AnalyticsManifestFeatureV1,
  AnalyticsManifestTypeV1,
  AnalyticsManifestV1,
} from "./analytics-manifest";
