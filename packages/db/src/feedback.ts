import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

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
  category: "BUG_REPORT" | "FEATURE_REQUEST" | "QUESTION" | "OTHER";
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
