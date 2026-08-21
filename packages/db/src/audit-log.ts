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
    // 持ち主を確かめられない古い Customer を置き換えたが、そこにまだ請求の
    // 続く subscription が残っていた。metadata が無いので、それがこの利用者の
    // ものだという証拠が無く、こちらから解約すると別人の契約を止めかねない
    // ——人が見て決められるように、手掛かりだけを残す。
    legacyCustomerLeftBilling: "account.legacyCustomerLeftBilling",
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
    aiSettingChanged: "admin.aiSettingChanged",
    aiSettingReset: "admin.aiSettingReset",
    aiOperationModelSaved: "admin.aiOperationModelSaved",
    aiOperationModelRemoved: "admin.aiOperationModelRemoved",
    aiCreditsAdjusted: "admin.aiCreditsAdjusted",
    aiMonthlyUsageAdjusted: "admin.aiMonthlyUsageAdjusted",
    packageCheckoutResolution: "admin.packageCheckoutResolution",
    topUpCheckoutInterventionResumed: "admin.topUpCheckoutInterventionResumed",
    topUpCheckoutInterventionTerminalized: "admin.topUpCheckoutInterventionTerminalized",
    storageMultipartInterventionResumed: "admin.storageMultipartInterventionResumed",
    storageMultipartInterventionTerminalized: "admin.storageMultipartInterventionTerminalized",
    storageUploadInterventionResumed: "admin.storageUploadInterventionResumed",
    storageUploadInterventionTerminalized: "admin.storageUploadInterventionTerminalized",
    packagePaymentRefundInterventionResumed: "admin.packagePaymentRefundInterventionResumed",
    storageObjectMoved: "admin.storageObjectMoved",
  },
  git: {
    accountProvisioned: "git.accountProvisioned",
    createRepository: "git.createRepository",
    renameRepository: "git.renameRepository",
    deleteRepository: "git.deleteRepository",
    issueCredential: "git.issueCredential",
    revokeCredential: "git.revokeCredential",
    accountDeleted: "git.accountDeleted",
    // purge に失敗して Forgejo 側にユーザーが残った。自動では再試行されないので、
    // 手で消すための手がかりをここに残す。
    accountPurgeFailed: "git.accountPurgeFailed",
    // 自動では決着できない (控えの相手が別人になっている、利用者が消えたのに
    // 印が進んでいない)。人が判断するまで Forgejo 側にアカウントが残りうる。
    accountNeedsReview: "git.accountNeedsReview",
    // 退会を始めたまま消えた処理の印を外した。外さないとその利用者は資格情報の
    // 発行も退会もできない。
    deletionMarkerReleased: "git.deletionMarkerReleased",
    // 消したはずの Forgejo アカウントが戻っていた (Forgejo だけを退会前の時点に
    // 復元した場合など)。端末のトークンごと復活するので、消し直した記録を残す。
    accountResurrected: "git.accountResurrected",
    // テンプレートを入れ切れなかったリポジトリを読み取り専用にした。
    // clone はできるが push は通らない。同名で作り直すと修復される。
    repositoryLocked: "git.repositoryLocked",
    // 発行したトークンの控えを残せず、Forgejo 側の取り消しにも失敗した。
    // 一覧に出ないので利用者は失効できない。手で消すための手掛かりを残す。
    credentialOrphaned: "git.credentialOrphaned",
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
  prisma,
}: {
  action?: string;
  userId?: string;
  page: number;
  pageSize: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  const where = {
    action: action || undefined,
    userId: userId || undefined,
  };
  const [items, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      // port と userAgent は管理画面で使わないので取得しない。
      select: {
        id: true,
        userId: true,
        action: true,
        details: true,
        ipAddress: true,
        createdAt: true,
      },
      // createdAt だけではページ境界で同時刻の行が重複・欠落するため id で確定させる。
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.auditLog.count({
      where,
    }),
  ]);
  return { items, total };
}
