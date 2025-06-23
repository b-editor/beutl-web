import "server-only";
import { drizzle } from "@/drizzle";
import type { Transaction } from "./transaction";
import { headers } from "next/headers";
import { file } from "@/drizzle/schema";
import { eq } from "drizzle-orm";

export async function getContentUrl(id?: string | null) {
  if (!id) return null;
  const url = (await headers()).get("x-url") as string;
  const origin = new URL(url).origin;
  return `${origin}/api/contents/${id}`;
}

export async function retrieveFilesByUserId({
  userId,
  transaction,
}: {
  userId: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  return db.select()
    .from(file)
    .where(eq(file.userId, userId));
}

export async function createFile({
  userId,
  name,
  objectKey,
  size,
  mimeType,
  visibility,
  transaction,
  sha256,
}: {
  userId: string;
  name: string;
  objectKey: string;
  size: number;
  mimeType: string;
  visibility: "PUBLIC" | "PRIVATE" | "DEDICATED";
  transaction?: Transaction;
  sha256?: string;
}) {
  const db = transaction || await drizzle();
  return await db.insert(file)
    .values({
      objectKey,
      name,
      size,
      mimeType,
      userId,
      visibility,
      sha256,
    })
    .returning()
    .then((res) => res[0]);
}

export async function deleteFile({
  fileId,
  transaction,
}: {
  fileId: string;
  transaction?: Transaction;
}) {
  const db = transaction || await drizzle();
  return await db.delete(file)
    .where(eq(file.id, fileId))
    .returning()
    .then((res) => {
      if (res.length === 0) {
        throw new Error("File not found");
      }
      return res[0];
    })
}
