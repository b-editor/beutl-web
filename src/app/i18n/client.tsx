"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import i18next from "i18next";
import {
  initReactI18next,
  useTranslation as useTranslationOrigin,
} from "react-i18next";
import resourcesToBackend from "i18next-resources-to-backend";
import { getOptions } from "./settings";
import { z } from "zod";
import { zodI18nMap } from "zod-i18n-map";

i18next
  .use(initReactI18next)
  .use(
    resourcesToBackend(
      (language: string, namespace: string) =>
        import(`./locales/${language}/${namespace}.json`),
    ),
  )
  .init(getOptions());

z.setErrorMap(zodI18nMap);
export { z };

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

interface LanguageContextType {
  language: string;
  setLanguage: (language: string) => void;
}

const LanguageContext = createContext<LanguageContextType | undefined>(
  undefined,
);

interface LanguageProviderProps {
  children: ReactNode;
  initialLanguage: string;
}

export const LanguageProvider = ({
  children,
  initialLanguage,
}: LanguageProviderProps) => {
  const [language, setLanguage] = useState<string>(initialLanguage);

  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = (): LanguageContextType => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
};
