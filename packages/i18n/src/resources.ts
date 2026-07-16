// 全 locale JSON を静的 import した resource map。
// i18next-resources-to-backend の動的 import (import(`./locales/${lang}/${ns}.json`)) は
// Cloudflare Workers バンドラで解決不能なため、静的 import に置換する。
import en_account from "./locales/en/account.json";
import en_apiErrors from "./locales/en/api-errors.json";
import en_auth from "./locales/en/auth.json";
import en_developer from "./locales/en/developer.json";
import en_feedback from "./locales/en/feedback.json";
import en_main from "./locales/en/main.json";
import en_storage from "./locales/en/storage.json";
import en_store from "./locales/en/store.json";
import en_translation from "./locales/en/translation.json";
import ja_account from "./locales/ja/account.json";
import ja_apiErrors from "./locales/ja/api-errors.json";
import ja_auth from "./locales/ja/auth.json";
import ja_developer from "./locales/ja/developer.json";
import ja_feedback from "./locales/ja/feedback.json";
import ja_main from "./locales/ja/main.json";
import ja_storage from "./locales/ja/storage.json";
import ja_store from "./locales/ja/store.json";
import ja_translation from "./locales/ja/translation.json";

export const resources = {
  en: {
    account: en_account,
    "api-errors": en_apiErrors,
    auth: en_auth,
    developer: en_developer,
    feedback: en_feedback,
    main: en_main,
    storage: en_storage,
    store: en_store,
    translation: en_translation,
  },
  ja: {
    account: ja_account,
    "api-errors": ja_apiErrors,
    auth: ja_auth,
    developer: ja_developer,
    feedback: ja_feedback,
    main: ja_main,
    storage: ja_storage,
    store: ja_store,
    translation: ja_translation,
  },
} as const;
