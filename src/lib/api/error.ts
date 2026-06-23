import "server-only";
import { getTranslation } from "@/app/i18n/server";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { JwtTokenExpired } from "hono/utils/jwt/types";

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
] as const;

export type ApiErrorCode = (typeof errorCodes)[number];

export type ApiErrorResponse = {
  error_code: ApiErrorCode;
  message: string;
  documentation_url: string | null;
};

export async function apiErrorResponse(
  errorCode: ApiErrorCode,
): Promise<ApiErrorResponse> {
  const { t } = await getTranslation();
  return {
    error_code: errorCode,
    message: t(`api-errors:${errorCode}`),
    documentation_url: null,
  };
}

export const apiOnErrorHandler: ErrorHandler = async (err, c) => {
  console.error(err);
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  if (err instanceof JwtTokenExpired) {
    return c.json(await apiErrorResponse("authenticationIsRequired"), {
      status: 401,
    });
  }
  return c.json(await apiErrorResponse("unknown"), {
    status: 500,
  });
};
