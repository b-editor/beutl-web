import { createInstance } from "i18next";
import resourcesToBackend from "i18next-resources-to-backend";
import { initReactI18next } from "react-i18next/initReactI18next";
import { getOptions, defaultLanguage } from "./settings";
import { makeZodI18nMap, zodI18nMap } from "zod-i18n-map";
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

export async function getTranslation(lang = defaultLanguage) {
  const i18nextInstance = await initI18next(lang);
  const t = i18nextInstance.getFixedT(lang);

  z.setErrorMap(makeZodI18nMap({ t }));

  return {
    t: t,
    i18n: i18nextInstance,
    z,
  };
}

export type Translator = Awaited<ReturnType<typeof getTranslation>>["t"];

export type Zod = typeof z;
