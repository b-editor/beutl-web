/**
 * Auth.js から Better Auth へのデータ移行スクリプト
 *
 * このスクリプトは以下のデータを移行します:
 * 1. User.emailVerified (DateTime? → Boolean)
 * 2. Account (複合ID → 単一ID、フィールド名変更)
 * 3. Session (sessionToken → token、expires → expiresAt)
 * 4. Authenticator → Passkey (テーブル名・構造変更)
 * 5. VerificationToken → Verification
 *
 * 使用方法:
 * npx tsx scripts/migrate-auth-data.ts
 */

import { Pool } from "pg";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    console.log("Starting auth data migration...");
    await client.query("BEGIN");

    // 1. User.emailVerified の変換 (DateTime? → Boolean)
    console.log("1. Converting User.emailVerified...");
    await client.query(`
      ALTER TABLE "User"
      ADD COLUMN IF NOT EXISTS "emailVerified_new" BOOLEAN DEFAULT false;
    `);
    await client.query(`
      UPDATE "User"
      SET "emailVerified_new" = CASE
        WHEN "emailVerified" IS NOT NULL THEN true
        ELSE false
      END;
    `);
    await client.query(`
      ALTER TABLE "User" DROP COLUMN IF EXISTS "emailVerified";
    `);
    await client.query(`
      ALTER TABLE "User" RENAME COLUMN "emailVerified_new" TO "emailVerified";
    `);
    console.log("   User.emailVerified converted successfully");

    // 2. Account テーブルの変換
    console.log("2. Converting Account table...");

    // 新しいAccountテーブルを作成
    await client.query(`
      CREATE TABLE IF NOT EXISTS "Account_new" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "accountId" TEXT NOT NULL,
        "providerId" TEXT NOT NULL,
        "accessToken" TEXT,
        "refreshToken" TEXT,
        "accessTokenExpiresAt" TIMESTAMP(3),
        "refreshTokenExpiresAt" TIMESTAMP(3),
        "scope" TEXT,
        "idToken" TEXT,
        "password" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Account_new_pkey" PRIMARY KEY ("id")
      );
    `);

    // 古いAccountからデータを移行
    await client.query(`
      INSERT INTO "Account_new" ("id", "userId", "accountId", "providerId", "accessToken", "refreshToken", "accessTokenExpiresAt", "scope", "idToken", "createdAt", "updatedAt")
      SELECT
        gen_random_uuid()::text,
        "userId",
        "providerAccountId",
        "provider",
        "accessToken",
        "refreshToken",
        CASE WHEN "expiresAt" IS NOT NULL THEN to_timestamp("expiresAt"::double precision) ELSE NULL END,
        "scope",
        "idToken",
        COALESCE("createdAt", CURRENT_TIMESTAMP),
        COALESCE("updatedAt", CURRENT_TIMESTAMP)
      FROM "Account";
    `);

    // 外部キー制約とインデックスを追加
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "Account_new_providerId_accountId_key"
      ON "Account_new" ("providerId", "accountId");
    `);
    await client.query(`
      ALTER TABLE "Account_new"
      ADD CONSTRAINT "Account_new_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
    `);

    // 古いテーブルを削除し、新しいテーブルをリネーム
    await client.query(`DROP TABLE IF EXISTS "Account" CASCADE;`);
    await client.query(`ALTER TABLE "Account_new" RENAME TO "Account";`);
    await client.query(`ALTER INDEX "Account_new_pkey" RENAME TO "Account_pkey";`);
    await client.query(`ALTER INDEX "Account_new_providerId_accountId_key" RENAME TO "Account_providerId_accountId_key";`);
    await client.query(`ALTER TABLE "Account" RENAME CONSTRAINT "Account_new_userId_fkey" TO "Account_userId_fkey";`);

    console.log("   Account table converted successfully");

    // 3. Session テーブルの変換
    console.log("3. Converting Session table...");
    await client.query(`
      ALTER TABLE "Session"
      RENAME COLUMN "sessionToken" TO "token";
    `);
    await client.query(`
      ALTER TABLE "Session"
      RENAME COLUMN "expires" TO "expiresAt";
    `);
    await client.query(`
      ALTER TABLE "Session"
      ADD COLUMN IF NOT EXISTS "ipAddress" TEXT,
      ADD COLUMN IF NOT EXISTS "userAgent" TEXT;
    `);
    console.log("   Session table converted successfully");

    // 4. Authenticator → Passkey 移行
    console.log("4. Converting Authenticator to Passkey...");

    // Passkeyテーブルを作成
    await client.query(`
      CREATE TABLE IF NOT EXISTS "Passkey" (
        "id" TEXT NOT NULL,
        "name" TEXT,
        "publicKey" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "credentialID" TEXT NOT NULL,
        "counter" INTEGER NOT NULL,
        "deviceType" TEXT NOT NULL,
        "backedUp" BOOLEAN NOT NULL,
        "transports" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "aaguid" TEXT,
        "usedAt" TIMESTAMP(3),
        CONSTRAINT "Passkey_pkey" PRIMARY KEY ("id")
      );
    `);

    // Authenticatorからデータを移行
    await client.query(`
      INSERT INTO "Passkey" ("id", "name", "publicKey", "userId", "credentialID", "counter", "deviceType", "backedUp", "transports", "createdAt", "usedAt")
      SELECT
        gen_random_uuid()::text,
        "name",
        "credentialPublicKey",
        "userId",
        "credentialID",
        "counter",
        "credentialDeviceType",
        "credentialBackedUp",
        "transports",
        COALESCE("createdAt", CURRENT_TIMESTAMP),
        "usedAt"
      FROM "Authenticator"
      ON CONFLICT DO NOTHING;
    `);

    // インデックスと外部キーを追加
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "Passkey_credentialID_key"
      ON "Passkey" ("credentialID");
    `);
    await client.query(`
      ALTER TABLE "Passkey"
      ADD CONSTRAINT "Passkey_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
    `);

    // 古いAuthenticatorテーブルを削除
    await client.query(`DROP TABLE IF EXISTS "Authenticator" CASCADE;`);

    console.log("   Passkey table created and data migrated");

    // 5. VerificationToken → Verification 移行
    console.log("5. Converting VerificationToken to Verification...");

    // Verificationテーブルを作成
    await client.query(`
      CREATE TABLE IF NOT EXISTS "Verification" (
        "id" TEXT NOT NULL,
        "identifier" TEXT NOT NULL,
        "value" TEXT NOT NULL,
        "expiresAt" TIMESTAMP(3) NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
      );
    `);

    // VerificationTokenからデータを移行
    await client.query(`
      INSERT INTO "Verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt")
      SELECT
        gen_random_uuid()::text,
        "identifier",
        "token",
        "expires",
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM "VerificationToken"
      ON CONFLICT DO NOTHING;
    `);

    // 古いVerificationTokenテーブルを削除
    await client.query(`DROP TABLE IF EXISTS "VerificationToken" CASCADE;`);

    console.log("   Verification table created and data migrated");

    await client.query("COMMIT");
    console.log("\nMigration completed successfully!");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
