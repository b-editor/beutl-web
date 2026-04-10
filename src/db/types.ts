import type { InferSelectModel } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  confirmationTokenPurposeEnum,
  fileVisibilityEnum,
  paymentIntervalEnum,
  feedbackCategoryEnum,
} from "./schema";
import * as schema from "./schema";
import * as relations from "./relations";

const fullSchema = { ...schema, ...relations };

// ============ Transaction Type ============

export type DbTransaction = PgTransaction<
  PgQueryResultHKT,
  typeof fullSchema,
  ExtractTablesWithRelations<typeof fullSchema>
>;

// ============ Enum Types ============

export type ConfirmationTokenPurpose =
  (typeof confirmationTokenPurposeEnum.enumValues)[number];
export type FileVisibility = (typeof fileVisibilityEnum.enumValues)[number];
export type PaymentInterval = (typeof paymentIntervalEnum.enumValues)[number];
export type FeedbackCategory = (typeof feedbackCategoryEnum.enumValues)[number];

// ============ Enum Values (for use as constants) ============

export const ConfirmationTokenPurpose = {
  EMAIL_UPDATE: "EMAIL_UPDATE",
  ACCOUNT_DELETE: "ACCOUNT_DELETE",
} as const;

export const FileVisibility = {
  PUBLIC: "PUBLIC",
  PRIVATE: "PRIVATE",
  DEDICATED: "DEDICATED",
} as const;

export const PaymentInterval = {
  ONCE: "ONCE",
  MONTHLY: "MONTHLY",
  YEARLY: "YEARLY",
} as const;

export const FeedbackCategory = {
  BUG_REPORT: "BUG_REPORT",
  FEATURE_REQUEST: "FEATURE_REQUEST",
  QUESTION: "QUESTION",
  OTHER: "OTHER",
} as const;

// ============ Model Types ============

export type User = InferSelectModel<typeof schema.user>;
export type Account = InferSelectModel<typeof schema.account>;
export type Session = InferSelectModel<typeof schema.session>;
export type Verification = InferSelectModel<typeof schema.verification>;
export type Passkey = InferSelectModel<typeof schema.passkey>;
export type ConfirmationToken = InferSelectModel<
  typeof schema.confirmationToken
>;
export type Profile = InferSelectModel<typeof schema.profile>;
export type SocialProfile = InferSelectModel<typeof schema.socialProfile>;
export type SocialProfileProvider = InferSelectModel<
  typeof schema.socialProfileProvider
>;
export type File = InferSelectModel<typeof schema.file>;
export type Package = InferSelectModel<typeof schema.packageTable>;
export type PackagePricing = InferSelectModel<typeof schema.packagePricing>;
export type PackageScreenshot = InferSelectModel<
  typeof schema.packageScreenshot
>;
export type UserPackage = InferSelectModel<typeof schema.userPackage>;
export type Release = InferSelectModel<typeof schema.release>;
export type NativeAppAuth = InferSelectModel<typeof schema.nativeAppAuth>;
export type AuditLog = InferSelectModel<typeof schema.auditLog>;
export type Customer = InferSelectModel<typeof schema.customer>;
export type UserPaymentHistory = InferSelectModel<
  typeof schema.userPaymentHistory
>;
export type AppReleaseAsset = InferSelectModel<typeof schema.appReleaseAsset>;
export type Feedback = InferSelectModel<typeof schema.feedback>;
