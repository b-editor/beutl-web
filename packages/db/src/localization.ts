import { startRetryableTransaction, type PrismaTransaction } from "./transaction";

// Package / Release の説明文の翻訳行。原文は Package.description などの
// 既存列に残したまま、言語ごとの上書きだけをここへ書く。空文字は「その言語の
// 翻訳は無い」と同じ意味なので、行ごと消して原文フォールバックに戻す。
//
// フィールドの undefined は「この呼び出しでは触らない」を意味する。短い説明と
// 説明は別のフォームから別々に保存されるので、片方だけを編集しても、もう
// 片方の翻訳が消えないようにするため。

export type PackageTranslationDraft = {
  lang: string;
  displayName?: string | null;
  shortDescription?: string | null;
  description?: string | null;
};

export type ReleaseTranslationDraft = {
  lang: string;
  description?: string | null;
};

function nonEmpty(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value : null;
}

/** 指定言語の翻訳行を要求した形に置き換える。空のみの言語は行を削除する。 */
export async function upsertPackageTranslations({
  packageId,
  translations,
  prisma,
}: {
  packageId: string;
  translations: readonly PackageTranslationDraft[];
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    for (const translation of translations) {
      if (
        translation.displayName === undefined &&
        translation.shortDescription === undefined &&
        translation.description === undefined
      ) {
        continue;
      }
      const displayName = translation.displayName === undefined
        ? undefined
        : nonEmpty(translation.displayName);
      const shortDescription = translation.shortDescription === undefined
        ? undefined
        : nonEmpty(translation.shortDescription);
      const description = translation.description === undefined
        ? undefined
        : nonEmpty(translation.description);
      const row = await tx.packageTranslation.upsert({
        where: { packageId_lang: { packageId, lang: translation.lang } },
        create: {
          packageId,
          lang: translation.lang,
          displayName: displayName ?? null,
          shortDescription: shortDescription ?? null,
          description: description ?? null,
        },
        update: {
          ...(displayName !== undefined ? { displayName } : {}),
          ...(shortDescription !== undefined ? { shortDescription } : {}),
          ...(description !== undefined ? { description } : {}),
        },
      });
      // 別フォームが持つフィールドを消しただけの場合は行を残し、全フィールドが
      // 空になったときだけ行を削除して原文フォールバックへ戻す。
      if (!row.displayName && !row.shortDescription && !row.description) {
        await tx.packageTranslation.deleteMany({
          where: { packageId, lang: translation.lang },
        });
      }
    }
  };
  if (prisma) {
    await run(prisma);
  } else {
    await startRetryableTransaction(run);
  }
}

/** 指定言語のリリースノート翻訳行を要求した形に置き換える。 */
export async function upsertReleaseTranslations({
  releaseId,
  translations,
  prisma,
}: {
  releaseId: string;
  translations: readonly ReleaseTranslationDraft[];
  prisma?: PrismaTransaction;
}) {
  const run = async (tx: PrismaTransaction) => {
    for (const translation of translations) {
      if (translation.description === undefined) {
        continue;
      }
      const description = nonEmpty(translation.description);
      if (description === null) {
        await tx.releaseTranslation.deleteMany({
          where: { releaseId, lang: translation.lang },
        });
        continue;
      }
      await tx.releaseTranslation.upsert({
        where: { releaseId_lang: { releaseId, lang: translation.lang } },
        create: { releaseId, lang: translation.lang, description },
        update: { description },
      });
    }
  };
  if (prisma) {
    await run(prisma);
  } else {
    await startRetryableTransaction(run);
  }
}

/**
 * 言語を絞って翻訳行を取り込む select。表示・検索のどちらも、必要とする
 * 言語の行さえあれば原文へ落とせる。
 */
export function packageTranslationSelect(lang: string) {
  return {
    PackageTranslation: {
      where: { lang },
      select: {
        lang: true,
        displayName: true,
        shortDescription: true,
        description: true,
      },
    },
  } as const;
}

export function releaseTranslationSelect(lang: string) {
  return {
    ReleaseTranslation: {
      where: { lang },
      select: { lang: true, description: true },
    },
  } as const;
}

/** 全言語の翻訳行 (編集画面が言語ごとの下書きを復元するため)。 */
export function allPackageTranslationsSelect() {
  return {
    PackageTranslation: {
      select: {
        lang: true,
        displayName: true,
        shortDescription: true,
        description: true,
      },
      orderBy: { lang: "asc" as const },
    },
  } as const;
}

export function allReleaseTranslationsSelect() {
  return {
    ReleaseTranslation: {
      select: { lang: true, description: true },
      orderBy: { lang: "asc" as const },
    },
  } as const;
}
