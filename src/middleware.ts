import { type NextRequest, NextResponse } from "next/server";
import Negotiator from "negotiator";
import { defaultLanguage, availableLanguages } from "@/app/i18n/settings";

const getNegotiatedLanguage = (
  headers: Negotiator.Headers,
): string | undefined => {
  return new Negotiator({ headers }).language([...availableLanguages]);
};

export function middleware(request: NextRequest) {
  const newRequest = request.clone();
  const url = `${request.headers.get("x-forwarded-proto")}://${request.headers.get("x-forwarded-host")}${request.nextUrl.pathname}${request.nextUrl.search}`;
  newRequest.headers.set("x-url", url);
  newRequest.headers.set("x-pathname", request.nextUrl.pathname);

  const headers = {
    "accept-language": request.headers.get("accept-language") ?? "",
  };
  const preferredLanguage = getNegotiatedLanguage(headers) || defaultLanguage;

  const pathname = `${request.nextUrl.pathname}${request.nextUrl.search}`;

  if (
    ["/img", "/robots.txt", "/_next", "/api"].find((i) =>
      pathname.startsWith(i),
    )
  ) {
    return NextResponse.next({
      request: {
        headers: newRequest.headers,
      },
    });
  }

  const pathnameIsMissingLocale = availableLanguages.every(
    (lang) => !pathname.startsWith(`/${lang}/`) && pathname !== `/${lang}`,
  );

  if (pathnameIsMissingLocale) {
    if (preferredLanguage !== defaultLanguage) {
      return NextResponse.redirect(
        new URL(`/${preferredLanguage}${pathname}`, url),
      );
    }

    const newPathname = `/${defaultLanguage}${pathname}`;
    return NextResponse.rewrite(new URL(newPathname, request.url), {
      request: {
        headers: newRequest.headers,
      },
    });
  }

  return NextResponse.next({
    request: {
      headers: newRequest.headers,
    },
  });
}

export const config = {
  matcher: [
    // Skip all internal paths (_next)
    "/((?!_next).*)",
    // "/((?!api|static|.*\\..*|_next).*)",
    // Optional: only run on root (/) URL
    // '/'
  ],
};
