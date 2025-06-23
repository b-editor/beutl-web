import { relations } from "drizzle-orm/relations";
import { user, auditLog, file, packages, release, customer, nativeAppAuth, profile, session, packagePricing, userPaymentHistory, socialProfileProvider, socialProfile, userPackage, confirmationToken, packageScreenshot, authenticator, account } from "./schema";

export const auditLogRelations = relations(auditLog, ({ one }) => ({
	// auditLog.userId → user.id
	user: one(user, {
		fields: [auditLog.userId],
		references: [user.id]
	}),
}));

export const userRelations = relations(user, ({ many }) => ({
	auditLogs: many(auditLog),
	files: many(file),
	packages: many(packages),
	customers: many(customer),
	nativeAppAuths: many(nativeAppAuth),
	profiles: many(profile),
	sessions: many(session),
	userPaymentHistories: many(userPaymentHistory),
	socialProfiles: many(socialProfile),
	userPackages: many(userPackage),
	confirmationTokens: many(confirmationToken),
	authenticators: many(authenticator),
	accounts: many(account),
}));

export const fileRelations = relations(file, ({ one, many }) => ({
	// file.userId → user.id
	user: one(user, {
		fields: [file.userId],
		references: [user.id]
	}),
	packages: many(packages),
	profiles: many(profile),
	releases: many(release),
	packageScreenshots: many(packageScreenshot),
}));

export const packageRelations = relations(packages, ({ one, many }) => ({
	// packages.iconFileId → file.id
	file: one(file, {
		fields: [packages.iconFileId],
		references: [file.id]
	}),
	// packages.userId → user.id
	user: one(user, {
		fields: [packages.userId],
		references: [user.id]
	}),
	packagePricings: many(packagePricing),
	releases: many(release),
	userPackages: many(userPackage),
	packageScreenshots: many(packageScreenshot),
}));

export const releaseRelations = relations(release, ({ one }) => ({
	// release.fileId → file.id
	file: one(file, {
		fields: [release.fileId],
		references: [file.id]
	}),
	// release.packageId → packages.id
	package: one(packages, {
		fields: [release.packageId],
		references: [packages.id]
	}),
}));

export const customerRelations = relations(customer, ({ one }) => ({
	user: one(user, {
		fields: [customer.userId],
		references: [user.id]
	}),
}));

export const nativeAppAuthRelations = relations(nativeAppAuth, ({ one }) => ({
	user: one(user, {
		fields: [nativeAppAuth.userId],
		references: [user.id]
	}),
}));

export const profileRelations = relations(profile, ({ one }) => ({
	file: one(file, {
		fields: [profile.iconFileId],
		references: [file.id]
	}),
	user: one(user, {
		fields: [profile.userId],
		references: [user.id]
	}),
}));

export const sessionRelations = relations(session, ({ one }) => ({
	user: one(user, {
		fields: [session.userId],
		references: [user.id]
	}),
}));

export const packagePricingRelations = relations(packagePricing, ({ one }) => ({
	package: one(packages, {
		fields: [packagePricing.packageId],
		references: [packages.id]
	}),
}));

export const userPaymentHistoryRelations = relations(userPaymentHistory, ({ one }) => ({
	user: one(user, {
		fields: [userPaymentHistory.userId],
		references: [user.id]
	}),
}));

export const socialProfileRelations = relations(socialProfile, ({ one }) => ({
	socialProfileProvider: one(socialProfileProvider, {
		fields: [socialProfile.providerId],
		references: [socialProfileProvider.id]
	}),
	user: one(user, {
		fields: [socialProfile.userId],
		references: [user.id]
	}),
}));

export const socialProfileProviderRelations = relations(socialProfileProvider, ({ many }) => ({
	socialProfiles: many(socialProfile),
}));

export const userPackageRelations = relations(userPackage, ({ one }) => ({
	package: one(packages, {
		fields: [userPackage.packageId],
		references: [packages.id]
	}),
	user: one(user, {
		fields: [userPackage.userId],
		references: [user.id]
	}),
}));

export const confirmationTokenRelations = relations(confirmationToken, ({ one }) => ({
	user: one(user, {
		fields: [confirmationToken.userId],
		references: [user.id]
	}),
}));

export const packageScreenshotRelations = relations(packageScreenshot, ({ one }) => ({
	file: one(file, {
		fields: [packageScreenshot.fileId],
		references: [file.id]
	}),
	package: one(packages, {
		fields: [packageScreenshot.packageId],
		references: [packages.id]
	}),
}));

export const authenticatorRelations = relations(authenticator, ({ one }) => ({
	user: one(user, {
		fields: [authenticator.userId],
		references: [user.id]
	}),
}));

export const accountRelations = relations(account, ({ one }) => ({
	user: one(user, {
		fields: [account.userId],
		references: [user.id]
	}),
}));