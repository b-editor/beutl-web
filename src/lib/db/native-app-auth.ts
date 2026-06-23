import "server-only";
import { getDbAsync } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function updateNativeAppAuthCode({
  id: identifier,
  userId,
  codeExpires,
  code,
  prisma,
}: {
  id: string;
  userId: string;
  codeExpires: Date;
  code: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.nativeAppAuth.update({
    where: {
      id: identifier,
    },
    data: {
      userId,
      codeExpires,
      code,
    },
  });
}
