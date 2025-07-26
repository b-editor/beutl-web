import { availableLanguages, defaultLanguage } from "@/app/i18n/settings";
import Negotiator from "negotiator";
import { headers } from "next/headers";
import "server-only";

const getNegotiatedLanguage = (
  headers: Negotiator.Headers,
): string | undefined => {
  return new Negotiator({ headers }).language([...availableLanguages]);
};

export async function getLanguage() {
  const h = await headers();

  const sim = {
    "accept-language": h.get("accept-language") ?? "",
  };
  const preferredLanguage = getNegotiatedLanguage(sim) || defaultLanguage;

  const pathname = new URL(h.get("x-url") as string).pathname;
  const pathnameIsMissingLocale = availableLanguages.every(
    (lang) => !pathname.startsWith(`/${lang}/`) && pathname !== `/${lang}`,
  );

  if (pathnameIsMissingLocale) {
    return preferredLanguage;
  }

  return pathname.split("/")[1];
}
