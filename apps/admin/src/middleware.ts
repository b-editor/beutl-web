import type { NextRequest } from "next/server";
import { localeMiddleware } from "@beutl/next/middleware";

// matcher は Next.js がこのファイルから静的に読み取るため、共有パッケージへ
// 移さず各アプリで宣言する。処理本体は localeMiddleware に集約している。
export function middleware(request: NextRequest) {
  return localeMiddleware(request);
}

export const config = {
  matcher: [
    // Skip all internal paths (_next)
    "/((?!_next).*)",
  ],
};
