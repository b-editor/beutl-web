import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

export type AiOperationModelRecord = {
  operation: string;
  modelId: string;
  /** Which provider runs this model. Rows predating the column say "openrouter". */
  provider: string;
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
      provider: true,
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
  provider,
  priceUnits,
  displayName,
  sortOrder,
  enabled,
  updatedBy,
  prisma,
}: {
  operation: string;
  modelId: string;
  /**
   * Who runs the model. A new row without one belongs to the provider that
   * existed before the column did; an existing row without one keeps the
   * provider it has, because omitting a field is not a request to re-route a
   * model that is already registered.
   */
  provider?: string;
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
      provider: provider ?? "openrouter",
      priceUnits,
      displayName,
      sortOrder,
      enabled,
      updatedBy,
    },
    update: {
      ...(provider === undefined ? {} : { provider }),
      priceUnits,
      displayName,
      sortOrder,
      enabled,
      updatedBy,
    },
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
