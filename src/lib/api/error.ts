import "server-only";
import { getTranslation } from "@/app/i18n/server";

export const errorCodes = {
  unknown: 0,
  
  // 認証
  authenticationIsRequired: 1,
  doNotHavePermissions: 2,

  // パッケージ
  packageNotFound: 3,
  packageNotFoundById: 4,
  packageIsPrivate: 5,

  // ユーザー
  userNotFound: 6,
  userNotFoundById: 7,

  // 検証
  invalidPackageName: 8,
  invalidAssetName: 9,
  invalidLocaleId: 10,
  invalidReleaseVersion: 11,
  invalidRefreshToken: 12,
  invalidRequestBody: 13,
  assetMustHaveAtLeastOneHashValue: 14,
  invalidVersionFormat: 15,

  // パッケージリソース
  packageResourceNotFound: 16,
  packageResourceHasAlreadyBeenAdded: 17,

  // リリース
  releaseNotFound: 18,
  releaseNotFoundById: 19,
  cannotPublishAReleaseThatDoesNotHaveAnAsset: 20,

  // リリースリソース
  releaseResourceNotFound: 21,
  releaseResourceHasAlreadyBeenAdded: 22,

  // アセット
  assetNotFound: 23,
  assetNotFoundById: 24,
  rawAssetNotFound: 25,
  noFilesDataInTheRequest: 26,
  fileIsTooLarge: 27,
  virtualAssetCannotBeDownloaded: 28,
  cannotDeleteReleaseAssets: 29,
} as const;

export type ApiErrorResponse = {
  error_code: keyof typeof errorCodes;
  message: string;
  documentation_url: string | null;
};

export async function apiErrorResponse(
  errorCode: keyof typeof errorCodes,
): Promise<ApiErrorResponse> {
  const { t } = await getTranslation();
  return {
    error_code: errorCode,
    message: t(`api-errors:${errorCode}`),
    documentation_url: null,
  };
}
