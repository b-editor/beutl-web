import { getTranslation } from "@beutl/i18n";
import { RequestBodyLimitExceededError } from "@beutl/core";
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

  // AI
  "aiPlanRequired",
  "aiUsageLimitExceeded",
  "aiProviderError",
  "aiJobNotFound",
  "aiJobLimitReached",
  "aiJobIsActive",
  "aiRequestInProgress",
  "aiRequestWasDeleted",
  "aiModelUnavailable",
  "aiModelDoesNotSupportRequest",
  "aiResultUnavailable",
  // 同じ名前で、前とは違う依頼が届いた。「本文が壊れている」とは別のことで、
  // 呼び出し側の出方も違う——中身を戻せばその名前で結果を取り戻せるし、戻さない
  // なら新しい名前で出し直せばよい。ひとまとめに invalidRequestBody で返すと、
  // どちらなのか分からないまま名前を捨てることになる。
  "aiRequestChanged",
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
  if (err instanceof RequestBodyLimitExceededError) {
    return c.json(await apiErrorResponse("fileIsTooLarge"), {
      status: 413,
    });
  }
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
