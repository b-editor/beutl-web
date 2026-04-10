import { relations } from "drizzle-orm";
import {
  user,
  account,
  session,
  passkey,
  confirmationToken,
  profile,
  socialProfile,
  socialProfileProvider,
  file,
  packageTable,
  packagePricing,
  packageScreenshot,
  userPackage,
  release,
  nativeAppAuth,
  auditLog,
  customer,
  userPaymentHistory,
  feedback,
} from "./schema";

// ============ User Relations ============

export const userRelations = relations(user, ({ one, many }) => ({
  accounts: many(account),
  sessions: many(session),
  passkeys: many(passkey),
  confirmationTokens: many(confirmationToken),
  profile: one(profile),
  socialProfiles: many(socialProfile),
  files: many(file),
  packages: many(packageTable),
  userPackages: many(userPackage),
  auditLogs: many(auditLog),
  customer: one(customer),
  nativeAppAuths: many(nativeAppAuth),
  userPaymentHistories: many(userPaymentHistory),
  feedbacks: many(feedback),
}));

// ============ Account Relations ============

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

// ============ Session Relations ============

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

// ============ Passkey Relations ============

export const passkeyRelations = relations(passkey, ({ one }) => ({
  user: one(user, { fields: [passkey.userId], references: [user.id] }),
}));

// ============ ConfirmationToken Relations ============

export const confirmationTokenRelations = relations(
  confirmationToken,
  ({ one }) => ({
    user: one(user, {
      fields: [confirmationToken.userId],
      references: [user.id],
    }),
  }),
);

// ============ Profile Relations ============

export const profileRelations = relations(profile, ({ one }) => ({
  user: one(user, { fields: [profile.userId], references: [user.id] }),
  iconFile: one(file, { fields: [profile.iconFileId], references: [file.id] }),
}));

// ============ SocialProfileProvider Relations ============

export const socialProfileProviderRelations = relations(
  socialProfileProvider,
  ({ many }) => ({
    socialProfiles: many(socialProfile),
  }),
);

// ============ SocialProfile Relations ============

export const socialProfileRelations = relations(socialProfile, ({ one }) => ({
  user: one(user, { fields: [socialProfile.userId], references: [user.id] }),
  provider: one(socialProfileProvider, {
    fields: [socialProfile.providerId],
    references: [socialProfileProvider.id],
  }),
}));

// ============ File Relations ============

export const fileRelations = relations(file, ({ one, many }) => ({
  user: one(user, { fields: [file.userId], references: [user.id] }),
  packages: many(packageTable),
  packageScreenshots: many(packageScreenshot),
  profiles: many(profile),
  releases: many(release),
}));

// ============ Package Relations ============

export const packageRelations = relations(packageTable, ({ one, many }) => ({
  user: one(user, {
    fields: [packageTable.userId],
    references: [user.id],
  }),
  iconFile: one(file, {
    fields: [packageTable.iconFileId],
    references: [file.id],
  }),
  packagePricings: many(packagePricing),
  packageScreenshots: many(packageScreenshot),
  releases: many(release),
  userPackages: many(userPackage),
}));

// ============ PackagePricing Relations ============

export const packagePricingRelations = relations(
  packagePricing,
  ({ one }) => ({
    package: one(packageTable, {
      fields: [packagePricing.packageId],
      references: [packageTable.id],
    }),
  }),
);

// ============ PackageScreenshot Relations ============

export const packageScreenshotRelations = relations(
  packageScreenshot,
  ({ one }) => ({
    package: one(packageTable, {
      fields: [packageScreenshot.packageId],
      references: [packageTable.id],
    }),
    file: one(file, {
      fields: [packageScreenshot.fileId],
      references: [file.id],
    }),
  }),
);

// ============ UserPackage Relations ============

export const userPackageRelations = relations(userPackage, ({ one }) => ({
  user: one(user, { fields: [userPackage.userId], references: [user.id] }),
  package: one(packageTable, {
    fields: [userPackage.packageId],
    references: [packageTable.id],
  }),
}));

// ============ Release Relations ============

export const releaseRelations = relations(release, ({ one }) => ({
  package: one(packageTable, {
    fields: [release.packageId],
    references: [packageTable.id],
  }),
  file: one(file, { fields: [release.fileId], references: [file.id] }),
}));

// ============ NativeAppAuth Relations ============

export const nativeAppAuthRelations = relations(nativeAppAuth, ({ one }) => ({
  user: one(user, { fields: [nativeAppAuth.userId], references: [user.id] }),
}));

// ============ AuditLog Relations ============

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  user: one(user, { fields: [auditLog.userId], references: [user.id] }),
}));

// ============ Customer Relations ============

export const customerRelations = relations(customer, ({ one }) => ({
  user: one(user, { fields: [customer.userId], references: [user.id] }),
}));

// ============ UserPaymentHistory Relations ============

export const userPaymentHistoryRelations = relations(
  userPaymentHistory,
  ({ one }) => ({
    user: one(user, {
      fields: [userPaymentHistory.userId],
      references: [user.id],
    }),
  }),
);

// ============ Feedback Relations ============

export const feedbackRelations = relations(feedback, ({ one }) => ({
  user: one(user, { fields: [feedback.userId], references: [user.id] }),
}));
