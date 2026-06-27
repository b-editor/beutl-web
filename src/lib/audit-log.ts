import "server-only";
import { createAuditLog } from "@/lib/db/audit-log";
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
  admin: {
    updatePackagePricing: "admin.updatePackagePricing",
    updatePackageInterval: "admin.updatePackageInterval",
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
  const h = await headers();

  const ipAddress = h.get("x-real-ip") || h.get("X-Forwarded-For")?.split(",")[0];
  const userAgent = h.get("User-Agent");
  const port = h.get("Mod-CF-Client-Port");
  await createAuditLog({
    userId,
    action,
    details,
    ipAddress,
    userAgent,
    port,
  });
}
