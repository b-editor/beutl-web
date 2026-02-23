import { createInstance } from "i18next";
import resourcesToBackend from "i18next-resources-to-backend";
import { initReactI18next } from "react-i18next/initReactI18next";
import { getOptions, defaultLanguage, AvailableLanguage } from "./settings";
import { z } from "zod";

const initI18next = async (lang: string) => {
  const i18nInstance = createInstance();
  await i18nInstance
    .use(initReactI18next)
    .use(
      resourcesToBackend(
        (language: string, namespace: string) =>
          import(`./locales/${language}/${namespace}.json`),
      ),
    )
    .init(getOptions(lang));
  return i18nInstance;
};

export async function getTranslation(lang: AvailableLanguage = defaultLanguage) {
  const i18nextInstance = await initI18next(lang);
  const t = i18nextInstance.getFixedT(lang);

  if (lang === "en") {
    z.config(z.locales.en());
  } else if (lang === "ja") {
    z.config(z.locales.ja());
  }

  return {
    t: t,
    i18n: i18nextInstance,
    z,
  };
}

export type Translator = Awaited<ReturnType<typeof getTranslation>>["t"];

export type Zod = typeof z;
