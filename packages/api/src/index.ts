// Shared services for Web, Admin and Workers. HTTP composition lives in ./app.
export {
  apiOnErrorHandler,
  apiErrorResponse,
  errorCodes,
  fileTooLargeApiResponse,
} from "./api/error";
export type { ApiErrorCode, ApiErrorResponse } from "./api/error";
export { getUserId, getUserIdFromHeaders, getUserIdFromToken, tryGetUserIdFromHeaders } from "./api/auth";
export { getContentUrl, contentPath } from "./content-url";
export * from "./ai";
export { getStorageEntitlement } from "./storage-entitlements";
export type { StorageEntitlementResponse } from "./storage-entitlements";
export {
  abandonStaleStorageUploads,
  isTerminalMultipartAbortError,
  reconcileStorageMultipartCleanups,
} from "./storage-uploads";
export {
  configuredStorageProviders,
  createStorageBucket,
  createStorageStores,
  resolveStorageBucket,
  resolveStorageStores,
  storageProviderOf,
  STORAGE_PROVIDERS,
} from "./storage/bucket-from-env";
export type { StorageProvider, StorageStore, StorageStores } from "./storage/bucket-from-env";
export {
  locateStorageObject,
  moveStorageObject,
  moveStorageObjectsBatch,
  StorageMoveError,
} from "./storage/move-object";
export type {
  MovableFile,
  MoveBatchOutcome,
  MoveOutcome,
  ObjectLocation,
  StorageMoveLease,
} from "./storage/move-object";
export { createLayeredBucket } from "./storage/layered-bucket";
export type { StorageStreamOptions } from "./ai/r2-provider";
export {
  createS3CompatibleBucket,
  S3StorageError,
} from "./storage/s3-compatible-bucket";
export type { S3CompatibleBucketOptions } from "./storage/s3-compatible-bucket";
export { closeStripeCustomerForAdminAccountDeletion } from "./account-deletion-stripe";
export {
  discoverPackageCheckoutAttempt,
  discoverTopUpCheckoutAttempt,
} from "./package-checkout-discovery";
export type { AdminStripeClosureResult } from "./account-deletion-stripe";
export { reconcileStripeCustomerProvisioning } from "./stripe-customer-provisioning";
