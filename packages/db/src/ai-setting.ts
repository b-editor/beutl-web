import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

export type AiSettingRecord = {
  key: string;
  value: string;
  updatedBy: string | null;
  updatedAt: Date;
};

// 設定は数十件程度なので、キー指定で引くより一括で読んで呼び出し側で引く方が
// ラウンドトリップが少ない。AI の各操作は 1 リクエストで 1 回だけ呼ぶ。
export async function listAiSettings({
  prisma,
}: {
  prisma?: PrismaTransaction;
} = {}): Promise<AiSettingRecord[]> {
  const db = prisma ?? await getDb();
  return db.aiSetting.findMany({
    select: {
      key: true,
      value: true,
      updatedBy: true,
      updatedAt: true,
    },
    orderBy: { key: "asc" },
  });
}

export async function getAiSettingMap({
  prisma,
}: {
  prisma?: PrismaTransaction;
} = {}): Promise<Map<string, string>> {
  const rows = await listAiSettings({ prisma });
  return new Map(rows.map((row) => [row.key, row.value]));
}

export async function upsertAiSetting({
  key,
  value,
  updatedBy,
  prisma,
}: {
  key: string;
  value: string;
  updatedBy: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return db.aiSetting.upsert({
    where: { key },
    create: { key, value, updatedBy },
    update: { value, updatedBy },
  });
}

// 既定値へ戻す操作は行の削除で表現する。解決側が「DB → 環境変数 → 既定値」の
// 順にフォールバックするため、行が無い状態がそのまま「既定に従う」を意味する。
export async function deleteAiSetting({
  key,
  prisma,
}: {
  key: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  await db.aiSetting.deleteMany({ where: { key } });
}
