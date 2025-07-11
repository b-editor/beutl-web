import "server-only";
import { getDbAsync } from "@/prisma";
import { headers } from "next/headers";

export const auditLogActions = {
  authjs: {
    createUser: "authjs.createUser",
    signIn: "authjs.signIn",
    signOut: "authjs.signOut",
    linkAccount: "authjs.linkAccount",
  },
  account: {
    sentEmailChangeConfirmation: "account.sentEmailChangeConfirmation",
    emailChanged: "account.emailChanged",
    sentDeleteAccountConfirmation: "account.sentDeleteAccountConfirmation",
    accountDeleted: "account.accountDeleted",
    signInMethodDeleted: "account.signInMethodDeleted",
  },
  developer: {
    createPackage: "developer.createPackage",
    updatePackage: "developer.updatePackage",
    deletePackage: "developer.deletePackage",
    publishPackage: "developer.publishPackage",
    unpublishPackage: "developer.unpublishPackage",
    createRelease: "developer.createRelease",
    updateRelease: "developer.updateRelease",
    deleteRelease: "developer.deleteRelease",
    publishRelease: "developer.publishRelease",
    unpublishRelease: "developer.unpublishRelease",
  },
  store: {
    addToLibrary: "store.addToLibrary",
    removeFromLibrary: "store.removeFromLibrary",
    paymentSucceeded: "store.paymentSucceeded",
  },
};

export async function addAuditLog({
  userId,
  action,
  details,
}: {
  userId: string | null;
  action: string;
  details?: string;
}) {
  const db = await getDbAsync();
  const h = await headers();

  const ipAddress = h.get("x-real-ip") || h.get("X-Forwarded-For")?.split(",")[0];
  const userAgent = h.get("User-Agent");
  const port = h.get("Mod-CF-Client-Port");
  await db.auditLog.create({
    data: {
      userId,
      action,
      details,
      ipAddress,
      userAgent,
      port,
    },
  });
}
