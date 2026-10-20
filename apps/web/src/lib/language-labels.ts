import "server-only";
import { availableLanguages } from "@beutl/i18n";

// 翻訳タブに出す言語の名前。Intl の表示データはランタイムごとに違いうるので
// (ブラウザが名指せない言語がある)、サーバーで解決して props として渡す。
export function languageLabels(lang: string): { code: string; name: string }[] {
  let display: Intl.DisplayNames | null = null;
  try {
    display = new Intl.DisplayNames([lang], { type: "language" });
  } catch {
    // 言語タグとして不正な値では Intl が RangeError を投げる。その場合も
    // この画面は落とさず、言語コードをそのまま名前に使う。
    display = null;
  }
  return availableLanguages.map((code) => ({
    code,
    name: display?.of(code) ?? code,
  }));
}

export type LanguageLabel = { code: string; name: string };
