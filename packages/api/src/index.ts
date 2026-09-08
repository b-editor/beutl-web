import { Hono } from "hono";
import { v1 } from "./v1";
import { v2 } from "./v2";
import { v3 } from "./v3";

// 全 API をプレフィックス付きでマウントした composed app。
// Web (Next.js route.ts) と独立 Worker (worker.ts) の両方から使える。
export const api = new Hono()
  .route("/api/v1", v1)
  .route("/api/v2", v2)
  .route("/api/v3", v3);

export { v1 } from "./v1";
export { v2 } from "./v2";
export { v3 } from "./v3";
export { parseReplayableAiJobInput, sanitizeAiJobInputParams } from "./v3/ai/jobs";
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
