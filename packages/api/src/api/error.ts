import { getTranslation } from "@beutl/i18n";
import { RequestBodyLimitExceededError, type ApiErrorCode } from "@beutl/core";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { JwtTokenExpired } from "hono/utils/jwt/types";

export { errorCodes } from "@beutl/core";
export type { ApiErrorCode } from "@beutl/core";

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

/** Canonical outer-boundary response for a request body over its route cap. */
export async function fileTooLargeApiResponse(): Promise<Response> {
  return Response.json(await apiErrorResponse("fileIsTooLarge"), {
    status: 413,
  });
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
