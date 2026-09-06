import type { NextRequest } from "next/server";
import { localeMiddleware } from "@beutl/next/middleware";

// matcher は Next.js がこのファイルから静的に読み取るため、共有パッケージへ
// 移さず各アプリで宣言する。処理本体は localeMiddleware に集約している。
export function middleware(request: NextRequest) {
  return localeMiddleware(request);
}

export const config = {
  matcher: [
    // _next と /api を除く。/api は localeMiddleware が素通しするだけだが、
    // matcher に含めると Next.js が本文を middleware 用に複製し、既定 10MB を
    // 超えた分を捨てるため、大きなアップロードが壊れて届く。
    "/((?!_next|api/).*)",
  ],
};
