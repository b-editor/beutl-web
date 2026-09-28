// The wire `error_code` is always the string key, never an index; array order
// carries no protocol meaning.
export const errorCodes = [
  "unknown",

  // 認証
  "authenticationIsRequired",
  "doNotHavePermissions",

  // パッケージ
  "packageNotFound",
  "packageNotFoundById",
  "packageIsPrivate",

  // ユーザー
  "userNotFound",
  "userNotFoundById",

  // 検証
  "invalidPackageName",
  "invalidAssetName",
  "invalidLocaleId",
  "invalidReleaseVersion",
  "invalidRefreshToken",
  "invalidRequestBody",
  "assetMustHaveAtLeastOneHashValue",
  "invalidVersionFormat",

  // パッケージリソース
  "packageResourceNotFound",
  "packageResourceHasAlreadyBeenAdded",

  // リリース
  "releaseNotFound",
  "releaseNotFoundById",
  "cannotPublishAReleaseThatDoesNotHaveAnAsset",

  // リリースリソース
  "releaseResourceNotFound",
  "releaseResourceHasAlreadyBeenAdded",

  // アセット
  "assetNotFound",
  "assetNotFoundById",
  "rawAssetNotFound",
  "noFilesDataInTheRequest",
  "fileIsTooLarge",
  "virtualAssetCannotBeDownloaded",
  "cannotDeleteReleaseAssets",

  // Storage
  "invalidStorageQuery",
  "invalidStorageCursor",
  "storageFileNotFound",
  "storageFolderNotFound",
  "storageFileInUse",
  "storageFolderInUse",
  "storageInvalidMove",
  "storageFolderNotEmpty",

  // AI
  "aiPlanRequired",
  "aiUsageLimitExceeded",
  "aiProviderError",
  "aiProviderBillingUnavailable",
  "aiJobNotFound",
  "aiJobLimitReached",
  "aiJobIsActive",
  "aiJobBillingInProgress",
  "aiRequestInProgress",
  "aiRequestWasDeleted",
  "aiModelUnavailable",
  "aiModelDoesNotSupportRequest",
  "aiProviderCostUnavailable",
  "aiResultUnavailable",
  // 同じ名前で、前とは違う依頼が届いた。「本文が壊れている」とは別のことで、
  // 呼び出し側の出方も違う——中身を戻せばその名前で結果を取り戻せるし、戻さない
  // なら新しい名前で出し直せばよい。ひとまとめに invalidRequestBody で返すと、
  // どちらなのか分からないまま名前を捨てることになる。
  "aiRequestChanged",
] as const;

export type ApiErrorCode = (typeof errorCodes)[number];

const knownErrorCodes: ReadonlySet<string> = new Set(errorCodes);

/** Whether a response names one of the shared public API error codes. */
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && knownErrorCodes.has(value);
}
