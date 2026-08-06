"use client";

import { useEffect } from "react";
import i18next from "i18next";
import {
  initReactI18next,
  useTranslation as useTranslationOrigin,
} from "react-i18next";
import { getOptions, resources } from "@beutl/i18n";

i18next
  .use(initReactI18next)
  .init({
    ...getOptions(),
    resources,
  });

export function useTranslation(lang: string) {
  const { t, i18n } = useTranslationOrigin();

  useEffect(() => {
    const shouldChangeLanguage = lang && lang !== i18n.resolvedLanguage;
    if (shouldChangeLanguage) {
      i18n.changeLanguage(lang);
    }
  }, [lang, i18n]);

  return { t, i18n };
}
