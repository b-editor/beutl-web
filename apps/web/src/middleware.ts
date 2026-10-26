import type { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { s3PublicOriginFromEnv } from "@beutl/api/storage/bucket-from-env";
import { localeMiddleware } from "@beutl/next/middleware";
import { applySecurityHeaders } from "@beutl/next/security-headers";
import { refuseOversizedAiUpload } from "@/lib/ai-upload-guard";

// matcher は Next.js がこのファイルから静的に読み取るため、共有パッケージへ
// 移さず各アプリで宣言する。処理本体は localeMiddleware に集約している。
function storageOrigin(): string | undefined {
  try {
    return s3PublicOriginFromEnv(getCloudflareContext().env);
  } catch {
    // Middleware may run without an OpenNext request context (tests, early
    // startup). Without an endpoint we simply omit the direct-upload CSP entry.
    return undefined;
  }
}

export function middleware(request: NextRequest) {
  // Action が FormData を組み立てる前に。境界ではない——素通りする道は
  // refuseOversizedAiUpload の説明にある。
  const oversized = refuseOversizedAiUpload(request);
  // 413 の応答にも同じヘッダーを付けるため、localeMiddleware の戻り値だけで
  // なく置き換わりの応答にも通す。
  return applySecurityHeaders(oversized ?? localeMiddleware(request), {
    NODE_ENV: process.env.NODE_ENV,
    STORAGE_ORIGIN: storageOrigin(),
  });
}

export const config = {
  matcher: [
    // _next と /api を除く。/api は localeMiddleware が素通しするだけだが、
    // matcher に含めると Next.js が本文を middleware 用に複製し、既定 10MB を
    // 超えた分を捨てる。20MB まで受け付ける AI のアップロードが、閉じ境界を
    // 欠いた multipart としてハンドラに届いていた。
    "/((?!_next|api/|\\.well-known/).*)",
  ],
};
