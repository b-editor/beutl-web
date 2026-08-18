export const defaultLanguage = "ja";
export const availableLanguages = [defaultLanguage, "en"];
export type AvailableLanguage = typeof availableLanguages[number];

// /[lang] は任意の文字列に一致するため、パス先頭のセグメントが言語である保証は
// ルート側で確かめるしかない。未対応の値をそのまま描画すると、i18next は既定
// 言語へ落ちて何事もないように見える一方、Intl は不正なロケールとして例外を
// 投げるため、画面ごとに現れ方の違う壊れ方をする。
export function isAvailableLanguage(value: string): boolean {
  return availableLanguages.includes(value);
}

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
  "dashboard",
  "admin",
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
