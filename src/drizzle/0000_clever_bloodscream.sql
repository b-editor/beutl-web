-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TYPE "public"."ConfirmationTokenPurpose" AS ENUM('EMAIL_UPDATE', 'ACCOUNT_DELETE');--> statement-breakpoint
CREATE TYPE "public"."FileVisibility" AS ENUM('PUBLIC', 'PRIVATE', 'DEDICATED');--> statement-breakpoint
CREATE TYPE "public"."PaymentInterval" AS ENUM('ONCE', 'MONTHLY', 'YEARLY');--> statement-breakpoint
CREATE TABLE "AuditLog" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text,
	"action" text NOT NULL,
	"details" text,
	"ipAddress" text,
	"userAgent" text,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL
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
CREATE TABLE "File" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"size" bigint NOT NULL,
	"mimeType" text NOT NULL,
	"objectKey" text NOT NULL,
	"userId" text NOT NULL,
	"sha256" text,
	"visibility" "FileVisibility" NOT NULL,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL
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
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL,
	"interval" "PaymentInterval"
);
--> statement-breakpoint
CREATE TABLE "CompatRelease" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"releaseId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Customer" (
	"userId" text PRIMARY KEY NOT NULL,
	"stripeId" text NOT NULL,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "NativeAppAuth" (
	"id" text PRIMARY KEY NOT NULL,
	"continueUrl" text NOT NULL,
	"sessionId" text NOT NULL,
	"userId" text,
	"code" text,
	"codeExpires" timestamp(3)
);
--> statement-breakpoint
CREATE TABLE "CompatPackage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"packageId" text NOT NULL
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
CREATE TABLE "Session" (
	"id" text PRIMARY KEY NOT NULL,
	"sessionToken" text NOT NULL,
	"userId" text NOT NULL,
	"expires" timestamp(3) NOT NULL,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PackagePricing" (
	"id" text PRIMARY KEY NOT NULL,
	"packageId" text NOT NULL,
	"price" integer NOT NULL,
	"currency" text NOT NULL,
	"fallback" boolean NOT NULL,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL
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
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "SocialProfileProvider" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"urlTemplate" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "UserPaymentHistory" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"paymentId" text NOT NULL,
	"packageId" text NOT NULL,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "User" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"emailVerified" timestamp(3),
	"image" text,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "CompatFile" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"fileId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "SocialProfile" (
	"value" text NOT NULL,
	"userId" text NOT NULL,
	"providerId" text NOT NULL,
	CONSTRAINT "SocialProfile_pkey" PRIMARY KEY("userId","providerId")
);
--> statement-breakpoint
CREATE TABLE "VerificationToken" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp(3) NOT NULL,
	CONSTRAINT "VerificationToken_pkey" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "UserPackage" (
	"userId" text NOT NULL,
	"packageId" text NOT NULL,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "UserPackage_pkey" PRIMARY KEY("userId","packageId")
);
--> statement-breakpoint
CREATE TABLE "ConfirmationToken" (
	"userId" text NOT NULL,
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp(3) NOT NULL,
	"purpose" "ConfirmationTokenPurpose" NOT NULL,
	CONSTRAINT "ConfirmationToken_pkey" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "PackageScreenshot" (
	"packageId" text NOT NULL,
	"fileId" text NOT NULL,
	"order" integer NOT NULL,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL,
	CONSTRAINT "PackageScreenshot_pkey" PRIMARY KEY("packageId","fileId")
);
--> statement-breakpoint
CREATE TABLE "Authenticator" (
	"credentialID" text NOT NULL,
	"userId" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"credentialPublicKey" text NOT NULL,
	"counter" integer NOT NULL,
	"credentialDeviceType" text NOT NULL,
	"credentialBackedUp" boolean NOT NULL,
	"transports" text,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL,
	"usedAt" timestamp(3),
	"name" text,
	CONSTRAINT "Authenticator_pkey" PRIMARY KEY("credentialID","userId")
);
--> statement-breakpoint
CREATE TABLE "Account" (
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refreshToken" text,
	"accessToken" text,
	"expiresAt" integer,
	"tokenType" text,
	"scope" text,
	"idToken" text,
	"sessionState" text,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL,
	CONSTRAINT "Account_pkey" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "File" ADD CONSTRAINT "File_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Package" ADD CONSTRAINT "Package_iconFileId_fkey" FOREIGN KEY ("iconFileId") REFERENCES "public"."File"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Package" ADD CONSTRAINT "Package_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "CompatRelease" ADD CONSTRAINT "CompatRelease_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "public"."Release"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "NativeAppAuth" ADD CONSTRAINT "NativeAppAuth_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "CompatPackage" ADD CONSTRAINT "CompatPackage_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "public"."Package"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_iconFileId_fkey" FOREIGN KEY ("iconFileId") REFERENCES "public"."File"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "PackagePricing" ADD CONSTRAINT "PackagePricing_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "public"."Package"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Release" ADD CONSTRAINT "Release_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "public"."File"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Release" ADD CONSTRAINT "Release_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "public"."Package"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "UserPaymentHistory" ADD CONSTRAINT "UserPaymentHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "CompatFile" ADD CONSTRAINT "CompatFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "public"."File"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "SocialProfile" ADD CONSTRAINT "SocialProfile_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "public"."SocialProfileProvider"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "SocialProfile" ADD CONSTRAINT "SocialProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "UserPackage" ADD CONSTRAINT "UserPackage_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "public"."Package"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "UserPackage" ADD CONSTRAINT "UserPackage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ConfirmationToken" ADD CONSTRAINT "ConfirmationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "PackageScreenshot" ADD CONSTRAINT "PackageScreenshot_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "public"."File"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "PackageScreenshot" ADD CONSTRAINT "PackageScreenshot_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "public"."Package"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Authenticator" ADD CONSTRAINT "Authenticator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "Package_name_key" ON "Package" USING btree ("name" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "CompatRelease_releaseId_key" ON "CompatRelease" USING btree ("releaseId" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "CompatPackage_packageId_key" ON "CompatPackage" USING btree ("packageId" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session" USING btree ("sessionToken" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "User_email_key" ON "User" USING btree ("email" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "CompatFile_fileId_key" ON "CompatFile" USING btree ("fileId" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "Authenticator_credentialID_key" ON "Authenticator" USING btree ("credentialID" text_ops);
*/