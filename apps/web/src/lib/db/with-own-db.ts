import { runWithDbProvider } from "@beutl/db";
import { withOwnPrismaClient } from "@/prisma";

/** Keep queries alive until work settles, even if a disconnect runs after(). */
export function withOwnDb<T>(work: () => Promise<T>): Promise<T> {
  return withOwnPrismaClient((prisma) =>
    runWithDbProvider(async () => prisma, work),
  );
}
