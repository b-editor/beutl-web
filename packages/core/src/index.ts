// @beutl/core: Next.js/Cloudflare に依存しない純粋ロジックの共有パッケージ。
// デスクトップ API (v1/v2/v3) と Web UI の両方から参照される。
export { selectPricing } from "./pricing";
export { formatAmount } from "./currency-formatter";
export { getRelativeTimeDifference } from "./relative-time";
export { isValidNuGetVersionRange } from "./nuget-version-range";
export { randomString, createHash } from "./create-hash";
export { cn, formatBytes } from "./utils";
export type { ActionResult } from "./action-result";
export { isAllowedContinueUrlHost } from "./native-auth";
export { isAdmin } from "./admin-guard";
export { resolveContentAccess } from "./content-access";
export type {
  ContentAccessFile,
  ContentAccessResult,
} from "./content-access";
