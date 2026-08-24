import type { NextRequest } from "next/server";
import { localeMiddleware } from "@beutl/next/middleware";
import { refuseOversizedAiUpload } from "@/lib/ai-upload-guard";

// matcher は Next.js がこのファイルから静的に読み取るため、共有パッケージへ
// 移さず各アプリで宣言する。処理本体は localeMiddleware に集約している。
export function middleware(request: NextRequest) {
  // 本文を組み立てる前に。Action が動きはじめてからでは、断るころには全部を
  // 抱えている。
  const oversized = refuseOversizedAiUpload(request);
  if (oversized) return oversized;

  return localeMiddleware(request);
}

export const config = {
  matcher: [
    // _next と /api を除く。/api は localeMiddleware が素通しするだけだが、
    // matcher に含めると Next.js が本文を middleware 用に複製し、既定 10MB を
    // 超えた分を捨てる。20MB まで受け付ける AI のアップロードが、閉じ境界を
    // 欠いた multipart としてハンドラに届いていた。
    "/((?!_next|api/).*)",
  ],
};
