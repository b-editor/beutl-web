import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

// AuditLog テーブルは web / admin の両方が書き込むため、action 名はここで一元管理する。
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
    paymentRevoked: "store.paymentRevoked",
    paymentRestored: "store.paymentRestored",
    paymentRefundFailed: "store.paymentRefundFailed",
    paymentRefundRequiresAction: "store.paymentRefundRequiresAction",
  },
  admin: {
    updatePackagePricing: "admin.updatePackagePricing",
    updatePackageInterval: "admin.updatePackageInterval",
    userDeleted: "admin.userDeleted",
    feedbackStatusChanged: "admin.feedbackStatusChanged",
  },
} as const;

export async function createAuditLog({
  userId,
  action,
  details,
  ipAddress,
  userAgent,
  port,
  prisma,
}: {
  userId: string | null;
  action: string;
  details?: string | null;
  ipAddress: string | null | undefined;
  userAgent: string | null | undefined;
  port: string | null | undefined;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return db.auditLog.create({
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

export async function listAuditLogs({
  action,
  userId,
  page,
  pageSize,
}: {
  action?: string;
  userId?: string;
  page: number;
  pageSize: number;
}) {
  const db = await getDb();
  const where = {
    action: action ? { equals: action } : undefined,
    userId: userId ? userId : undefined,
  };
  const [items, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: {
        createdAt: "desc",
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.auditLog.count({
      where,
    }),
  ]);
  return {
    items: items.map((item) => ({
      id: item.id,
      userId: item.userId,
      action: item.action,
      details: item.details,
      ipAddress: item.ipAddress,
      userAgent: item.userAgent,
      createdAt: item.createdAt,
    })),
    total,
  };
}

export async function countAuditLogs() {
  const db = await getDb();
  return db.auditLog.count();
}
