import { describe, expect, it } from "vitest";
import { availableLanguages, isAvailableLanguage } from "@beutl/i18n/settings";
import { getLanguageFromPathname } from "@beutl/i18n/language";

// middleware はこれらの接頭辞にロケールを付けずに通す。実体を持たないパス
// (管理画面には favicon.ico も robots.txt も無い) はそのまま /[lang] に一致する
// ため、ここに挙げた文字列が言語としてページへ届きうる。
const PATHS_WITHOUT_LOCALE_PREFIX = [
  "favicon.ico",
  "robots.txt",
  "img",
  "api",
  "_next",
];

describe("what may appear in the /[lang] segment", () => {
  it("takes every supported language as an Intl locale", () => {
    // 画面は同じ文字列を i18next と Intl の両方へ渡す。i18next は未知の言語を
    // 既定へ落とすだけだが、Intl は例外を投げてページごと落とすため、両者が
    // 受け付ける集合が一致していることがこのルートの前提になっている。
    for (const lang of availableLanguages) {
      expect(() => new Intl.DateTimeFormat(lang)).not.toThrow();
      expect(() => new Intl.NumberFormat(lang)).not.toThrow();
      expect(isAvailableLanguage(lang)).toBe(true);
    }
  });

  it("rejects the path segments that reach /[lang] without one", () => {
    for (const segment of PATHS_WITHOUT_LOCALE_PREFIX) {
      expect(isAvailableLanguage(segment)).toBe(false);
      expect(getLanguageFromPathname(`/${segment}`)).toBeUndefined();
    }
  });

  it("rejects a locale-shaped value that Intl still refuses", () => {
    // 言語らしく見えても BCP 47 として不正な値はある。長さや文字種で判断せず、
    // 対応言語の一覧との一致だけで決めていることを固定する。
    for (const segment of ["ja_JP", "j", ""]) {
      expect(() => new Intl.DateTimeFormat(segment)).toThrow(RangeError);
      expect(isAvailableLanguage(segment)).toBe(false);
    }
  });
});
