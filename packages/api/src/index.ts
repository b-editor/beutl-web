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
export { apiOnErrorHandler, apiErrorResponse, errorCodes } from "./api/error";
export type { ApiErrorCode, ApiErrorResponse } from "./api/error";
export { getUserId, getUserIdFromHeaders, getUserIdFromToken, tryGetUserIdFromHeaders } from "./api/auth";
export { getContentUrl, contentPath } from "./content-url";
export * from "./ai";
