"use server";

import { auth } from "@/auth";
import { prisma } from "@/prisma";

export async function retrieveFiles() {
  const session = await auth();
  return await prisma.file.findMany({
    where: {
      userId: session?.user?.id
    },
    select: {
      id: true,
      objectKey: true,
      name: true,
      size: true,
      mimeType: true,
      visibility: true,
    }
  });
}