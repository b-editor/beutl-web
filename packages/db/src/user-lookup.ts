import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

export async function existsUserById({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDb();
  return !!(await db.user.findFirst({
    where: {
      id: id,
    },
    select: {
      id: true,
    },
  }));
}
