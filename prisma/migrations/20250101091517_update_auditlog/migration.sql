-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "details" TEXT,
ALTER COLUMN "ipAddress" DROP NOT NULL,
ALTER COLUMN "userAgent" DROP NOT NULL;
