import Negotiator from "negotiator";
import { availableLanguages, defaultLanguage } from "./settings";

// negotiator は Node/Worker 前提のモジュールなので、この副次エントリはバレル
// (./index.ts) には含めない。クライアントバンドルに載せないこと。

export function getLanguageFromPathname(pathname: string): string | undefined {
  return availableLanguages.find(
    (lang) => pathname === `/${lang}` || pathname.startsWith(`/${lang}/`),
  );
}

export function negotiateLanguage(acceptLanguage: string): string {
  return (
    new Negotiator({
      headers: { "accept-language": acceptLanguage },
    }).language([...availableLanguages]) || defaultLanguage
  );
}

// middleware は既定ロケールを redirect ではなく rewrite するため、パスに接頭辞が
// 無いリクエストは既定ロケール扱いではなく Accept-Language で判定する。
export function resolveLanguage({
  pathname,
  acceptLanguage,
}: {
  pathname?: string | null;
  acceptLanguage?: string | null;
}): string {
  const fromPathname = pathname ? getLanguageFromPathname(pathname) : undefined;
  return fromPathname ?? negotiateLanguage(acceptLanguage ?? "");
}
