import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";
import { FeedbackCategory, FeedbackStatus } from "@prisma/client";

export { FeedbackCategory, FeedbackStatus };

export const feedbackStatuses = Object.values(FeedbackStatus);
export const feedbackCategories = Object.values(FeedbackCategory);

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return feedbackStatuses.includes(value as FeedbackStatus);
}

export function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return feedbackCategories.includes(value as FeedbackCategory);
}

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
  const where = { status, category };
  const [items, total] = await Promise.all([
    db.feedback.findMany({
      where,
      orderBy: {
        createdAt: "desc",
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.feedback.count({ where }),
  ]);
  return {
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      email: item.email,
      category: item.category,
      message: item.message,
      status: item.status,
      userId: item.userId,
      createdAt: item.createdAt,
    })),
    total,
  };
}

export async function countFeedback({
  status,
  prisma,
}: {
  status?: FeedbackStatus;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return db.feedback.count({
    where: {
      status,
    },
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
    },
  });
}
