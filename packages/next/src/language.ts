import "server-only";
import { resolveLanguage } from "@beutl/i18n/language";
import { headers } from "next/headers";

// middleware が付与するヘッダーからリクエストパスを取り出す。x-url は開発環境で
// x-forwarded-proto/host が欠けると解析不能な値になりうるため x-pathname を優先し、
// どちらも得られない場合は null (= Accept-Language での判定) にフォールバックする。
function getRequestPathname(h: Headers): string | null {
  const pathname = h.get("x-pathname");
  if (pathname) return pathname;

  const url = h.get("x-url");
  if (!url) return null;

  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

export async function getLanguage() {
  const h = await headers();

  return resolveLanguage({
    pathname: getRequestPathname(h),
    acceptLanguage: h.get("accept-language"),
  });
}
