// パッケージ/リリースの説明文のローカライズ。
//
// 原文は Package / Release の列そのままで、翻訳は言語ごとの行に入る。行が
// 無い言語・空のフィールドは原文を表示する。ここは純粋関数だけを置き、DB の
// 形 (Prisma の型) には依存しない。

export type LocalizedTranslation = {
  lang: string;
  displayName?: string | null;
  shortDescription?: string | null;
  description?: string | null;
};

/** 表示言語に対応する翻訳行。無ければ undefined (原文を表示する)。 */
export function pickTranslation<T extends { lang: string }>(
  translations: readonly T[] | null | undefined,
  lang: string,
): T | undefined {
  return translations?.find((translation) => translation.lang === lang);
}

/** 翻訳が空なら原文を返すフィールド単位のフォールバック。 */
export function resolveLocalizedText(
  original: string | null | undefined,
  translated: string | null | undefined,
): string {
  const value = translated?.trim();
  return value ? translated! : (original ?? "");
}

type PackageTextSource = {
  displayName: string | null;
  shortDescription: string;
  /** 表示言語で絞った翻訳行。select していない呼び出し元では undefined。 */
  PackageTranslation?: readonly LocalizedTranslation[] | null;
};

/** パッケージ名。識別子 (name) は翻訳せず、表示名だけを切り替える。 */
export function localizedDisplayName(
  pkg: PackageTextSource,
  lang: string,
): string {
  return resolveLocalizedText(
    pkg.displayName,
    pickTranslation(pkg.PackageTranslation, lang)?.displayName,
  );
}

export function localizedShortDescription(
  pkg: PackageTextSource,
  lang: string,
): string {
  return resolveLocalizedText(
    pkg.shortDescription,
    pickTranslation(pkg.PackageTranslation, lang)?.shortDescription,
  );
}

export function localizedPackageText(
  pkg: PackageTextSource & { description: string },
  lang: string,
) {
  const translation = pickTranslation(pkg.PackageTranslation, lang);
  return {
    displayName: resolveLocalizedText(
      pkg.displayName,
      translation?.displayName,
    ),
    shortDescription: resolveLocalizedText(
      pkg.shortDescription,
      translation?.shortDescription,
    ),
    description: resolveLocalizedText(pkg.description, translation?.description),
  };
}

type ReleaseTextSource = {
  description: string;
  ReleaseTranslation?: readonly LocalizedTranslation[] | null;
};

export function localizedReleaseDescription(
  release: ReleaseTextSource,
  lang: string,
): string {
  return resolveLocalizedText(
    release.description,
    pickTranslation(release.ReleaseTranslation, lang)?.description,
  );
}
