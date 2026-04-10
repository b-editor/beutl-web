CREATE TYPE "public"."ConfirmationTokenPurpose" AS ENUM('EMAIL_UPDATE', 'ACCOUNT_DELETE');--> statement-breakpoint
CREATE TYPE "public"."FeedbackCategory" AS ENUM('BUG_REPORT', 'FEATURE_REQUEST', 'QUESTION', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."FileVisibility" AS ENUM('PUBLIC', 'PRIVATE', 'DEDICATED');--> statement-breakpoint
CREATE TYPE "public"."PaymentInterval" AS ENUM('ONCE', 'MONTHLY', 'YEARLY');--> statement-breakpoint
CREATE TABLE "Account" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"accessTokenExpiresAt" timestamp (3),
	"refreshTokenExpiresAt" timestamp (3),
	"scope" text,
	"idToken" text,
	"password" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "Account_providerId_accountId_unique" UNIQUE("providerId","accountId")
);
--> statement-breakpoint
CREATE TABLE "AppReleaseAsset" (
	"id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"minVersion" text,
	"os" text NOT NULL,
	"arch" text NOT NULL,
	"type" text NOT NULL,
	"standalone" boolean NOT NULL,
	"url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AuditLog" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text,
	"action" text NOT NULL,
	"details" text,
	"ipAddress" text,
	"userAgent" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"port" text
);
--> statement-breakpoint
CREATE TABLE "ConfirmationToken" (
	"userId" text NOT NULL,
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp (3) NOT NULL,
	"purpose" "ConfirmationTokenPurpose" NOT NULL,
	CONSTRAINT "ConfirmationToken_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "Customer" (
	"userId" text PRIMARY KEY NOT NULL,
	"stripeId" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"category" "FeedbackCategory" NOT NULL,
	"message" text NOT NULL,
	"userId" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "File" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"size" bigint NOT NULL,
	"mimeType" text NOT NULL,
	"objectKey" text NOT NULL,
	"userId" text NOT NULL,
	"sha256" text,
	"visibility" "FileVisibility" NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "NativeAppAuth" (
	"id" text PRIMARY KEY NOT NULL,
	"continueUrl" text NOT NULL,
	"sessionId" text NOT NULL,
	"userId" text,
	"code" text,
	"codeExpires" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "PackagePricing" (
	"id" text PRIMARY KEY NOT NULL,
	"packageId" text NOT NULL,
	"price" integer NOT NULL,
	"currency" text NOT NULL,
	"fallback" boolean NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PackageScreenshot" (
	"packageId" text NOT NULL,
	"fileId" text NOT NULL,
	"order" integer NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	CONSTRAINT "PackageScreenshot_packageId_fileId_pk" PRIMARY KEY("packageId","fileId")
);
--> statement-breakpoint
CREATE TABLE "Package" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"displayName" text,
	"description" text NOT NULL,
	"shortDescription" text NOT NULL,
	"published" boolean NOT NULL,
	"webSite" text NOT NULL,
	"tags" text[],
	"iconFileId" text,
	"userId" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"interval" "PaymentInterval",
	CONSTRAINT "Package_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "Passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"publicKey" text NOT NULL,
	"userId" text NOT NULL,
	"credentialID" text NOT NULL,
	"counter" bigint NOT NULL,
	"deviceType" text NOT NULL,
	"backedUp" boolean NOT NULL,
	"transports" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"aaguid" text,
	"usedAt" timestamp (3),
	CONSTRAINT "Passkey_credentialID_unique" UNIQUE("credentialID")
);
--> statement-breakpoint
CREATE TABLE "Profile" (
	"userId" text PRIMARY KEY NOT NULL,
	"userName" text NOT NULL,
	"displayName" text NOT NULL,
	"bio" text,
	"iconFileId" text
);
--> statement-breakpoint
CREATE TABLE "Release" (
	"id" text PRIMARY KEY NOT NULL,
	"packageId" text NOT NULL,
	"version" text NOT NULL,
	"targetVersion" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"fileId" text,
	"published" boolean NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"userId" text NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	CONSTRAINT "Session_sessionToken_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "SocialProfile" (
	"value" text NOT NULL,
	"userId" text NOT NULL,
	"providerId" text NOT NULL,
	CONSTRAINT "SocialProfile_userId_providerId_pk" PRIMARY KEY("userId","providerId")
);
--> statement-breakpoint
CREATE TABLE "SocialProfileProvider" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"urlTemplate" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "User" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"image" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"emailVerified" boolean DEFAULT false,
	CONSTRAINT "User_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "UserPackage" (
	"userId" text NOT NULL,
	"packageId" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "UserPackage_userId_packageId_pk" PRIMARY KEY("userId","packageId")
);
--> statement-breakpoint
CREATE TABLE "UserPaymentHistory" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"paymentId" text NOT NULL,
	"packageId" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ConfirmationToken" ADD CONSTRAINT "ConfirmationToken_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "File" ADD CONSTRAINT "File_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "NativeAppAuth" ADD CONSTRAINT "NativeAppAuth_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PackagePricing" ADD CONSTRAINT "PackagePricing_packageId_Package_id_fk" FOREIGN KEY ("packageId") REFERENCES "public"."Package"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PackageScreenshot" ADD CONSTRAINT "PackageScreenshot_packageId_Package_id_fk" FOREIGN KEY ("packageId") REFERENCES "public"."Package"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PackageScreenshot" ADD CONSTRAINT "PackageScreenshot_fileId_File_id_fk" FOREIGN KEY ("fileId") REFERENCES "public"."File"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Package" ADD CONSTRAINT "Package_iconFileId_File_id_fk" FOREIGN KEY ("iconFileId") REFERENCES "public"."File"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Package" ADD CONSTRAINT "Package_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Passkey" ADD CONSTRAINT "Passkey_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_iconFileId_File_id_fk" FOREIGN KEY ("iconFileId") REFERENCES "public"."File"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Release" ADD CONSTRAINT "Release_packageId_Package_id_fk" FOREIGN KEY ("packageId") REFERENCES "public"."Package"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Release" ADD CONSTRAINT "Release_fileId_File_id_fk" FOREIGN KEY ("fileId") REFERENCES "public"."File"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SocialProfile" ADD CONSTRAINT "SocialProfile_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SocialProfile" ADD CONSTRAINT "SocialProfile_providerId_SocialProfileProvider_id_fk" FOREIGN KEY ("providerId") REFERENCES "public"."SocialProfileProvider"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "UserPackage" ADD CONSTRAINT "UserPackage_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "UserPackage" ADD CONSTRAINT "UserPackage_packageId_Package_id_fk" FOREIGN KEY ("packageId") REFERENCES "public"."Package"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "UserPaymentHistory" ADD CONSTRAINT "UserPaymentHistory_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;