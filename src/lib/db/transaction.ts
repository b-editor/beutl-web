import type { PrismaClient } from "@prisma/client";

export type PrismaTransaction = Parameters<
  Parameters<typeof PrismaClient.prototype.$transaction>[0]
>[0];
