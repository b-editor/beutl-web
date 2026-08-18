import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

export type AiOperationModelRecord = {
  operation: string;
  modelId: string;
  priceUnits: number;
  displayName: string | null;
  sortOrder: number;
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: Date;
};

// One bulk read for the same reason listAiSettings does it: there are only a few
// dozen rows and every AI request needs the whole catalog to resolve a model and
// its price together.
export async function listAiOperationModels({
  prisma,
}: {
  prisma?: PrismaTransaction;
} = {}): Promise<AiOperationModelRecord[]> {
  const db = prisma ?? (await getDb());
  return db.aiOperationModel.findMany({
    select: {
      operation: true,
      modelId: true,
      priceUnits: true,
      displayName: true,
      sortOrder: true,
      enabled: true,
      updatedBy: true,
      updatedAt: true,
    },
    orderBy: [
      { operation: "asc" },
      { sortOrder: "asc" },
      { modelId: "asc" },
    ],
  });
}

export async function upsertAiOperationModel({
  operation,
  modelId,
  priceUnits,
  displayName,
  sortOrder,
  enabled,
  updatedBy,
  prisma,
}: {
  operation: string;
  modelId: string;
  priceUnits: number;
  displayName: string | null;
  sortOrder: number;
  enabled: boolean;
  updatedBy: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return db.aiOperationModel.upsert({
    where: { operation_modelId: { operation, modelId } },
    create: {
      operation,
      modelId,
      priceUnits,
      displayName,
      sortOrder,
      enabled,
      updatedBy,
    },
    update: { priceUnits, displayName, sortOrder, enabled, updatedBy },
  });
}

// Which model a request that names none runs on is the lowest sortOrder, so
// making one the default is a renumbering of the whole operation rather than a
// flag on one row: a flag cannot be constrained to exactly one row, and two
// rows both claiming it would leave the default to chance.
export async function setAiOperationModelSortOrder({
  operation,
  modelId,
  sortOrder,
  updatedBy,
  prisma,
}: {
  operation: string;
  modelId: string;
  sortOrder: number;
  updatedBy: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.aiOperationModel.update({
    where: { operation_modelId: { operation, modelId } },
    data: { sortOrder, updatedBy },
  });
}

// Removing every row for an operation restores the built-in default, exactly as
// deleting an AiSetting row does.
export async function deleteAiOperationModel({
  operation,
  modelId,
  prisma,
}: {
  operation: string;
  modelId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.aiOperationModel.deleteMany({ where: { operation, modelId } });
}
