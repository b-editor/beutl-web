// Worker 版言語解決。Web 版は next/headers (x-url) に依存するため、
// リクエストヘッダ + request.url を直接受け取る形に置換する。
import { availableLanguages, defaultLanguage } from "@beutl/i18n";
import Negotiator from "negotiator";

const getNegotiatedLanguage = (
  headers: Negotiator.Headers,
): string | undefined => {
  return new Negotiator({ headers }).language([...availableLanguages]);
};

export async function getLanguage(request?: Request): Promise<string> {
  const acceptLanguage = request?.headers.get("accept-language") ?? "";
  const preferredLanguage = getNegotiatedLanguage({
    "accept-language": acceptLanguage,
  }) || defaultLanguage;

  const pathname = request ? new URL(request.url).pathname : "/";
  const pathnameIsMissingLocale = availableLanguages.every(
    (lang) => !pathname.startsWith(`/${lang}/`) && pathname !== `/${lang}`,
  );

  if (pathnameIsMissingLocale) {
    return preferredLanguage;
  }

  return pathname.split("/")[1];
}
