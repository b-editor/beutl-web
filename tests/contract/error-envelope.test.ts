import { describe, expect, it } from "vitest";

// エラーエンベロープ (packages/api/src/api/error.ts) のワイヤ契約を固定する。
// デスクトップアプリは error_code (文字列キー) + message をパースする。
// message は i18n 解決に依存するため、ここでは error_code と documentation_url の形状のみ検証する。

import {
  errorCodes,
  type ApiErrorCode,
  type ApiErrorResponse,
} from "@beutl/api";

describe("API error envelope (v1/v3 共通)", () => {
  it("errorCodes は文字列キーの配列で、数値プロトコルを含まない", () => {
    expect(Array.isArray(errorCodes)).toBe(true);
    expect(errorCodes.length).toBeGreaterThanOrEqual(28);
    for (const code of errorCodes) {
      expect(typeof code).toBe("string");
      expect(code).toMatch(/^[a-zA-Z]+$/);
    }
    // 契約上必須のキーが存在する
    for (const required of [
      "unknown",
      "authenticationIsRequired",
      "packageNotFound",
      "userNotFound",
      "invalidRequestBody",
      "invalidVersionFormat",
      "assetNotFound",
      "releaseNotFound",
    ]) {
      expect(errorCodes).toContain(required);
    }
  });

  it("ApiErrorResponse は error_code / message / documentation_url の 3 フィールド", () => {
    const resp: ApiErrorResponse = {
      error_code: "unknown" satisfies ApiErrorCode,
      message: "something",
      documentation_url: null,
    };
    expect(Object.keys(resp).sort()).toEqual([
      "documentation_url",
      "error_code",
      "message",
    ]);
  });
});
