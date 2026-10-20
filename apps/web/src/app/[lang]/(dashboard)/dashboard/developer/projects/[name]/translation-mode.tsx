"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { LanguageLabel } from "@/lib/language-labels";

// プロジェクト編集画面全体で共有する表示言語。原文 (null) を選ぶと従来どおり
// 原文の編集・プレビューになり、言語を選ぶとその言語で表示される内容を
// プレビューし、各フォームの翻訳欄をその言語で編集できる。
//
// 「追加された言語」は、既に翻訳が入っている言語と、この画面で言語の追加を
// 選んだ言語の集合。追加しただけの言語は保存時に空欄なら行が作られないので、
// 次回の読み込みでは一覧に戻らない。

type TranslationMode = {
  /** 表示・編集する言語。null は原文。 */
  language: string | null;
  /** このプロジェクトで有効にした言語。 */
  addedLanguages: LanguageLabel[];
  /** まだ追加されていない言語。 */
  availableLanguages: LanguageLabel[];
  addLanguage: (code: string) => void;
  setLanguage: (language: string | null) => void;
};

const TranslationModeContext = createContext<TranslationMode | null>(null);

const fallback: TranslationMode = {
  language: null,
  addedLanguages: [],
  availableLanguages: [],
  addLanguage: () => {},
  setLanguage: () => {},
};

export function TranslationModeProvider({
  languages,
  initialLanguages = [],
  defaultLanguage = null,
  children,
}: {
  languages: LanguageLabel[];
  /** 既に翻訳が入っている言語コード。 */
  initialLanguages?: readonly string[];
  defaultLanguage?: string | null;
  children: ReactNode;
}) {
  const [added, setAdded] = useState<string[]>(() => {
    const initial = initialLanguages.filter((code) =>
      languages.some((language) => language.code === code),
    );
    if (
      defaultLanguage &&
      languages.some((language) => language.code === defaultLanguage) &&
      !initial.includes(defaultLanguage)
    ) {
      initial.push(defaultLanguage);
    }
    return initial;
  });
  const [language, setLanguage] = useState<string | null>(
    defaultLanguage && languages.some((l) => l.code === defaultLanguage)
      ? defaultLanguage
      : null,
  );
  const addLanguage = useCallback((code: string) => {
    setAdded((current) => (current.includes(code) ? current : [...current, code]));
  }, []);
  const value = useMemo(
    () => ({
      language,
      addedLanguages: languages.filter((language) => added.includes(language.code)),
      availableLanguages: languages.filter((language) => !added.includes(language.code)),
      addLanguage,
      setLanguage,
    }),
    [language, languages, added, addLanguage],
  );
  return (
    <TranslationModeContext.Provider value={value}>
      {children}
    </TranslationModeContext.Provider>
  );
}

/** プロバイダーの外 (単体でフォームを描くテストなど) では原文として扱う。 */
export function useTranslationMode(): TranslationMode {
  return useContext(TranslationModeContext) ?? fallback;
}
