import { type NextRequest, NextResponse } from "next/server";
import { defaultLanguage } from "@beutl/i18n";
import {
  getLanguageFromPathname,
  negotiateLanguage,
} from "@beutl/i18n/language";

// ロケール接頭辞の付与と、サーバー側からリクエストパスを参照するための
// x-url / x-pathname 付与を行う。既定ロケールは redirect ではなく rewrite する
// ため、ブラウザ上のパスには接頭辞が付かないことがある (getLanguage 側で考慮)。
export function localeMiddleware(request: NextRequest) {
  const newRequest = request.clone();
  let url = request.url;
  if (process.env.NODE_ENV === "development") {
    url = `${request.headers.get("x-forwarded-proto")}://${request.headers.get("x-forwarded-host")}${request.nextUrl.pathname}${request.nextUrl.search}`;
  }

  newRequest.headers.set("x-url", url);
  newRequest.headers.set("x-pathname", request.nextUrl.pathname);

  const pathname = request.nextUrl.pathname;
  const search = request.nextUrl.search;

  if (
    ["/img", "/favicon.ico", "/robots.txt", "/_next", "/api"].some((i) =>
      pathname.startsWith(i),
    )
  ) {
    return NextResponse.next({
      request: {
        headers: newRequest.headers,
      },
    });
  }

  if (!getLanguageFromPathname(pathname)) {
    const preferredLanguage = negotiateLanguage(
      request.headers.get("accept-language") ?? "",
    );

    if (preferredLanguage !== defaultLanguage) {
      return NextResponse.redirect(
        new URL(`/${preferredLanguage}${pathname}${search}`, url),
      );
    }

    return NextResponse.rewrite(
      new URL(`/${defaultLanguage}${pathname}${search}`, request.url),
      {
        request: {
          headers: newRequest.headers,
        },
      },
    );
  }

  return NextResponse.next({
    request: {
      headers: newRequest.headers,
    },
  });
}
