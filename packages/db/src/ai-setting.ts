import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

export type AiSettingRecord = {
  key: string;
  value: string;
  updatedBy: string | null;
  updatedAt: Date;
};

// There are only a few dozen settings, so one bulk read costs fewer round trips
// than querying each key. Each AI operation loads this snapshot once.
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

// Deleting a row restores fallback resolution from environment to built-in
// default, so absence directly represents "use the configured fallback."
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
