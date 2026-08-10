// Worker 版言語解決。Web 版は next/headers (x-url) に依存するため、
// リクエストヘッダ + request.url を直接受け取る形に置換する。
import { resolveLanguage } from "@beutl/i18n/language";

export async function getLanguage(request?: Request): Promise<string> {
  return resolveLanguage({
    pathname: request ? new URL(request.url).pathname : "/",
    acceptLanguage: request?.headers.get("accept-language"),
  });
}
