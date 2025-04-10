export const defaultLanguage = "ja";
export const availableLanguages = [defaultLanguage, "en"];
export const namespaces = [
  "translation",
  "main",
  "effects",
  "docs",
  "store",
  "storage",
  "account",
  "auth",
  "authjs",
  "developer",
  "zod",
  "api-errors",
];

export function getOptions(lng = defaultLanguage) {
  return {
    lng,
    defaultNS: defaultLanguage,
    fallbackLng: defaultLanguage,
    fallbackNS: namespaces[0],
    ns: namespaces,
    supportedLngs: availableLanguages,
  };
}
