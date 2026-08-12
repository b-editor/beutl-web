export const defaultLanguage = "ja";
export const availableLanguages = [defaultLanguage, "en"];
export type AvailableLanguage = typeof availableLanguages[number];
export const namespaces = [
  "translation",
  "main",
  "store",
  "storage",
  "account",
  "auth",
  "api-errors",
  "feedback",
  "developer",
  "admin",
  "privacy",
  "telemetry",
];

export function getOptions(lng = defaultLanguage) {
  return {
    lng,
    defaultNS: "translation",
    fallbackLng: defaultLanguage,
    fallbackNS: namespaces[0],
    ns: namespaces,
    supportedLngs: availableLanguages,
  };
}
