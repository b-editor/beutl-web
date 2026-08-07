import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";
import type { Prisma } from "@prisma/client";

export type FeedbackStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED";

export type FeedbackCategory =
  | "BUG_REPORT"
  | "FEATURE_REQUEST"
  | "QUESTION"
  | "OTHER";

export async function createFeedback({
  name,
  email,
  category,
  message,
  userId,
  prisma,
}: {
  name: string;
  email: string;
  category: FeedbackCategory;
  message: string;
  userId: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.feedback.create({
    data: {
      name,
      email,
      category,
      message,
      userId,
    },
  });
}

export async function listFeedback({
  status,
  category,
  page,
  pageSize,
}: {
  status?: FeedbackStatus;
  category?: FeedbackCategory;
  page: number;
  pageSize: number;
}) {
  const db = await getDb();
  const [items, total] = await Promise.all([
    db.feedback.findMany({
      where: {
        status,
        category,
      } as Prisma.FeedbackWhereInput,
      orderBy: {
        createdAt: "desc",
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.feedback.count({
      where: {
        status,
        category,
      } as Prisma.FeedbackWhereInput,
    }),
  ]);
  return {
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      email: item.email,
      category: item.category as FeedbackCategory,
      message: item.message,
      status: (item as { status?: FeedbackStatus }).status as FeedbackStatus,
      userId: item.userId,
      createdAt: item.createdAt,
    })),
    total,
  };
}

export async function countFeedback({ status }: { status?: FeedbackStatus }) {
  const db = await getDb();
  return db.feedback.count({
    where: {
      status,
    } as Prisma.FeedbackWhereInput,
  });
}

export async function updateFeedbackStatus({
  id,
  status,
  prisma,
}: {
  id: string;
  status: FeedbackStatus;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return db.feedback.update({
    where: {
      id,
    },
    data: {
      status,
    } as Prisma.FeedbackUpdateInput,
  });
}
