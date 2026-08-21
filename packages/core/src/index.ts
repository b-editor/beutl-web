// @beutl/core: Next.js/Cloudflare に依存しない純粋ロジックの共有パッケージ。
// デスクトップ API (v1/v2/v3) と Web UI の両方から参照される。
export { selectPricing } from "./pricing";
export {
  formatAmount,
  formatFractionalAmount,
  isZeroDecimalCurrency,
} from "./currency-formatter";
export {
  toLocaleTag,
  formatDate,
  formatDateTime,
  formatCount,
} from "./locale";
export { getRelativeTimeDifference } from "./relative-time";
export { isValidNuGetVersionRange } from "./nuget-version-range";
export { randomString, randomUuid, createHash } from "./create-hash";
export { cn, formatBytes } from "./utils";
export {
  STORAGE_FILE_COUNT_LIMIT,
  STORAGE_QUOTA_BYTES,
  STORAGE_UPLOAD_PART_BYTES,
} from "./storage-quota";
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
export {
  AI_DEFAULT_OPERATION_MODELS,
  AI_OPERATIONS,
  AI_PLAN_MONTHLY_USAGE_LIMIT_KEY,
  AI_SETTINGS,
  AI_IMAGE_EDIT_TASKS,
  DEFAULT_MONTHLY_USAGE_LIMIT,
  MAX_MODEL_ID_LENGTH,
  MIN_PRICE_UNITS,
  MAX_PRICE_UNITS,
  MIN_MONTHLY_USAGE_LIMIT,
  MAX_MONTHLY_USAGE_LIMIT,
  isAiModelId,
  isAiSettingKey,
  validateAiSettingValue,
} from "./ai-settings";
export type {
  AiImageEditTask,
  AiOperation,
  AiSettingDefinition,
  AiSettingKind,
  AiSettingValidationError,
  AiSettingValidationResult,
} from "./ai-settings";
export {
  AI_PRICING_CATALOG,
  aiBillingUnitOf,
  aiMinimumChargeOf,
  aiMinimumQuantityOf,
} from "./ai-pricing-catalog";
export * from "./ai-capabilities";
export type { AiBillingUnit } from "./ai-pricing-catalog";
export {
  derivePlanUnitValue,
  deriveTopUpUnitValue,
  describeAllowanceEquivalent,
  describeAllowanceEquivalents,
  operationAmount,
} from "./ai-allowance";
export type {
  AiAllowanceEquivalent,
  AiAllowanceQuantityKind,
  AiUnitValue,
} from "./ai-allowance";
