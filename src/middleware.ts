import { NextRequest, NextResponse } from 'next/server';
import Negotiator from 'negotiator';
import { defaultLanguage, availableLanguages } from '@/app/i18n/settings';

const getNegotiatedLanguage = (
  headers: Negotiator.Headers,
): string | undefined => {
  return new Negotiator({ headers }).language([...availableLanguages]);
};

export function middleware(request: NextRequest) {
  request.headers.set('x-url', request.url);
  request.headers.set('x-pathname', request.nextUrl.pathname);

  const headers = {
    'accept-language': request.headers.get('accept-language') ?? '',
  };
  const preferredLanguage = getNegotiatedLanguage(headers) || defaultLanguage;

  const pathname = request.nextUrl.pathname;

  if (["/img", "/robots.txt", "/_next", "/api"].find(i => pathname.startsWith(i))) {
    return NextResponse.next({
      request: {
        headers: request.headers
      }
    });
  }

  const pathnameIsMissingLocale = availableLanguages.every(
    (lang) => !pathname.startsWith(`/${lang}/`) && pathname !== `/${lang}`,
  );

  if (pathnameIsMissingLocale) {
    if (preferredLanguage !== defaultLanguage) {
      return NextResponse.redirect(
        new URL(`/${preferredLanguage}${pathname}`, request.url),
      );
    } else {
      const newPathname = `/${defaultLanguage}${pathname}`;
      return NextResponse.rewrite(new URL(newPathname, request.url));
    }
  }

  return NextResponse.next({
    request: {
      headers: request.headers
    }
  });
}

export const config = {
  matcher: [
    // Skip all internal paths (_next)
    '/((?!_next).*)',
    // "/((?!api|static|.*\\..*|_next).*)",
    // Optional: only run on root (/) URL
    // '/'
  ],
}