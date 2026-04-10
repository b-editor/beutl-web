import "server-only";
import { getDbAsync } from "@/db";
import { passkey } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "./transaction";

export async function updatePasskeyUsedAt({
  credentialID,
  usedAt,
  tx,
}: {
  credentialID: string;
  usedAt: Date;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  await db
    .update(passkey)
    .set({ usedAt })
    .where(eq(passkey.credentialID, credentialID));
}

export async function deletePasskey({
  credentialID,
  userId,
  tx,
}: {
  credentialID: string;
  userId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  await db
    .delete(passkey)
    .where(
      and(eq(passkey.credentialID, credentialID), eq(passkey.userId, userId)),
    );
}

export async function updatePasskeyName({
  credentialID,
  userId,
  name,
  tx,
}: {
  credentialID: string;
  userId: string;
  name: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  await db
    .update(passkey)
    .set({ name })
    .where(
      and(eq(passkey.credentialID, credentialID), eq(passkey.userId, userId)),
    );
}

export async function getPasskeysByUserId({
  userId,
  tx,
}: {
  userId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  return await db
    .select({
      id: passkey.id,
      credentialID: passkey.credentialID,
      name: passkey.name,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
      createdAt: passkey.createdAt,
      usedAt: passkey.usedAt,
    })
    .from(passkey)
    .where(eq(passkey.userId, userId));
}

export async function findPasskeyByCredentialId({
  credentialID,
  tx,
}: {
  credentialID: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db.query.passkey.findFirst({
    where: eq(passkey.credentialID, credentialID),
  });
  return result ?? null;
}
