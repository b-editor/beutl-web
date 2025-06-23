import { pgTable, text, timestamp, boolean, bigint, integer, primaryKey, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const confirmationTokenPurpose = pgEnum("ConfirmationTokenPurpose", ['EMAIL_UPDATE', 'ACCOUNT_DELETE'])
export const fileVisibility = pgEnum("FileVisibility", ['PUBLIC', 'PRIVATE', 'DEDICATED'])
export const paymentInterval = pgEnum("PaymentInterval", ['ONCE', 'MONTHLY', 'YEARLY'])


export const auditLog = pgTable("AuditLog", {
	id: text().primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
	userId: text().references(() => user.id, { onUpdate: "cascade", onDelete: "set null" }),
	action: text().notNull(),
	details: text(),
	ipAddress: text(),
	userAgent: text(),
	createdAt: timestamp().default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const appReleaseAsset = pgTable("AppReleaseAsset", {
	id: text().primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
	version: text().notNull(),
	minVersion: text(),
	os: text().notNull(),
	arch: text().notNull(),
	type: text().notNull(),
	standalone: boolean().notNull(),
	url: text().notNull(),
});

export const file = pgTable("File", {
	id: text().primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
	name: text().notNull(),
	size: bigint({ mode: "number" }).notNull(),
	mimeType: text().notNull(),
	objectKey: text().notNull(),
	userId: text().notNull().references(() => user.id, { onUpdate: "cascade", onDelete: "cascade" }),
	sha256: text(),
	visibility: fileVisibility().notNull(),
	createdAt: timestamp().default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp().notNull().$onUpdate(() => sql`CURRENT_TIMESTAMP`),
});

export const packages = pgTable("Package", {
	id: text().primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
	name: text().notNull().unique(),
	displayName: text(),
	description: text().notNull(),
	shortDescription: text().notNull(),
	published: boolean().notNull(),
	webSite: text().notNull(),
	tags: text().array(),
	iconFileId: text().references(() => file.id, { onUpdate: "cascade", onDelete: "set null" }),
	userId: text().notNull().references(() => user.id, { onUpdate: "cascade", onDelete: "cascade" }),
	createdAt: timestamp().default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp().notNull().$onUpdate(() => sql`CURRENT_TIMESTAMP`),
	interval: paymentInterval(),
});

export const customer = pgTable("Customer", {
	userId: text().primaryKey().notNull().references(() => user.id, { onUpdate: "cascade", onDelete: "cascade" }),
	stripeId: text().notNull(),
	createdAt: timestamp().default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp().notNull().$onUpdate(() => sql`CURRENT_TIMESTAMP`),
});

export const nativeAppAuth = pgTable("NativeAppAuth", {
	id: text().primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
	continueUrl: text().notNull(),
	sessionId: text().notNull(),
	userId: text().references(() => user.id, { onUpdate: "cascade", onDelete: "cascade" }),
	code: text(),
	codeExpires: timestamp(),
});

export const profile = pgTable("Profile", {
	userId: text().primaryKey().notNull().references(() => user.id, { onUpdate: "cascade", onDelete: "cascade" }),
	userName: text().notNull(),
	displayName: text().notNull(),
	bio: text(),
	iconFileId: text().references(() => file.id, { onUpdate: "cascade", onDelete: "set null" }),
});

export const session = pgTable("Session", {
	id: text().primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
	sessionToken: text().notNull().unique(),
	userId: text().notNull().references(() => user.id, { onUpdate: "cascade", onDelete: "cascade" }),
	expires: timestamp().notNull(),
	createdAt: timestamp().default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp().notNull().$onUpdate(() => sql`CURRENT_TIMESTAMP`),
});

export const packagePricing = pgTable("PackagePricing", {
	id: text().primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
	packageId: text().notNull().references(() => packages.id, { onUpdate: "cascade", onDelete: "cascade" }),
	price: integer().notNull(),
	currency: text().notNull(),
	fallback: boolean().notNull(),
	createdAt: timestamp().default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp().notNull().$onUpdate(() => sql`CURRENT_TIMESTAMP`),
});

export const release = pgTable("Release", {
	id: text().primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
	packageId: text().notNull().references(() => packages.id, { onUpdate: "cascade", onDelete: "cascade" }),
	version: text().notNull(),
	targetVersion: text().notNull(),
	title: text().notNull(),
	description: text().notNull(),
	fileId: text().references(() => file.id, { onUpdate: "cascade", onDelete: "set null" }),
	published: boolean().notNull(),
	createdAt: timestamp().default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp().notNull().$onUpdate(() => sql`CURRENT_TIMESTAMP`),
});

export const socialProfileProvider = pgTable("SocialProfileProvider", {
	id: text().primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
	provider: text().notNull(),
	name: text().notNull(),
	urlTemplate: text().notNull(),
});

export const userPaymentHistory = pgTable("UserPaymentHistory", {
	id: text().primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
	userId: text().notNull().references(() => user.id, { onUpdate: "cascade", onDelete: "cascade" }),
	paymentId: text().notNull(),
	packageId: text().notNull(),
	createdAt: timestamp().default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp().notNull().$onUpdate(() => sql`CURRENT_TIMESTAMP`),
});

export const user = pgTable("User", {
	id: text().primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
	name: text(),
	email: text().notNull().unique(),
	emailVerified: timestamp(),
	image: text(),
	createdAt: timestamp().default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp().notNull().$onUpdate(() => sql`CURRENT_TIMESTAMP`),
});

export const socialProfile = pgTable("SocialProfile", {
	value: text().notNull(),
	userId: text().notNull().references(() => user.id, { onUpdate: "cascade", onDelete: "cascade" }),
	providerId: text().notNull().references(() => socialProfileProvider.id, { onUpdate: "cascade", onDelete: "cascade" }),
}, (table) => [
	primaryKey({ columns: [table.userId, table.providerId] })
]);

export const verificationToken = pgTable("VerificationToken", {
	identifier: text().notNull(),
	token: text().notNull(),
	expires: timestamp().notNull(),
}, (table) => [
	primaryKey({ columns: [table.identifier, table.token] }),
]);

export const userPackage = pgTable("UserPackage", {
	userId: text().notNull().references(() => user.id, { onUpdate: "cascade", onDelete: "cascade" }),
	packageId: text().notNull().references(() => packages.id, { onUpdate: "cascade", onDelete: "cascade" }),
	createdAt: timestamp().default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	primaryKey({ columns: [table.userId, table.packageId] }),
]);

export const confirmationToken = pgTable("ConfirmationToken", {
	userId: text().notNull().references(() => user.id, { onUpdate: "cascade", onDelete: "cascade" }),
	identifier: text().notNull(),
	token: text().notNull(),
	expires: timestamp().notNull(),
	purpose: confirmationTokenPurpose().notNull(),
}, (table) => [
	primaryKey({ columns: [table.identifier, table.token] }),
]);

export const packageScreenshot = pgTable("PackageScreenshot", {
	packageId: text().notNull().references(() => packages.id, { onUpdate: "cascade", onDelete: "cascade" }),
	fileId: text().notNull().references(() => file.id, { onUpdate: "cascade", onDelete: "cascade" }),
	order: integer().notNull(),
	createdAt: timestamp().default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp().notNull().$onUpdate(() => sql`CURRENT_TIMESTAMP`),
}, (table) => [
	primaryKey({ columns: [table.packageId, table.fileId] }),
]);

export const authenticator = pgTable("Authenticator", {
	credentialId: text().notNull().unique(),
	userId: text().notNull().references(() => user.id, { onUpdate: "cascade", onDelete: "cascade" }),
	providerAccountId: text().notNull(),
	credentialPublicKey: text().notNull(),
	counter: integer().notNull(),
	credentialDeviceType: text().notNull(),
	credentialBackedUp: boolean().notNull(),
	transports: text(),
	createdAt: timestamp().default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp().notNull().$onUpdate(() => sql`CURRENT_TIMESTAMP`),
	usedAt: timestamp(),
	name: text(),
}, (table) => [
	primaryKey({ columns: [table.credentialId, table.userId] }),
]);

export const account = pgTable("Account", {
	userId: text().notNull().references(() => user.id, { onUpdate: "cascade", onDelete: "cascade" }),
	type: text().notNull(),
	provider: text().notNull(),
	providerAccountId: text().notNull(),
	refreshToken: text(),
	accessToken: text(),
	expiresAt: integer(),
	tokenType: text(),
	scope: text(),
	idToken: text(),
	sessionState: text(),
	createdAt: timestamp().default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp().notNull().$onUpdate(() => sql`CURRENT_TIMESTAMP`),
}, (table) => [
	primaryKey({ columns: [table.provider, table.providerAccountId] }),
]);
