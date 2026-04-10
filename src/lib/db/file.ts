import "server-only";
import { getDbAsync } from "@/db";
import { file } from "@/db/schema";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import type { DbTransaction } from "./transaction";

export async function getContentUrl(id?: string | null) {
  if (!id) return null;
  const url = (await headers()).get("x-url") as string;
  const origin = new URL(url).origin;
  return `${origin}/api/contents/${id}`;
}

export async function retrieveFilesByUserId({
  userId,
  tx,
}: {
  userId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  return await db.query.file.findMany({
    where: eq(file.userId, userId),
  });
}

export async function createFile({
  userId,
  name,
  objectKey,
  size,
  mimeType,
  visibility,
  tx,
  sha256,
}: {
  userId: string;
  name: string;
  objectKey: string;
  size: number;
  mimeType: string;
  visibility: "PUBLIC" | "PRIVATE" | "DEDICATED";
  tx?: DbTransaction;
  sha256?: string;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .insert(file)
    .values({
      objectKey,
      name,
      size,
      mimeType,
      userId,
      visibility,
      sha256,
    })
    .returning();
  return result[0];
}

export async function deleteFile({
  fileId,
  tx,
}: {
  fileId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db.delete(file).where(eq(file.id, fileId)).returning();
  return result[0];
}
