/**
 * Passkey の credentialID を base64 から base64url に変換するスクリプト
 *
 * base64 → base64url の変換ルール:
 *   + → -
 *   / → _
 *   末尾の = を除去
 *
 * 使用方法:
 * npx tsx scripts/convert-credential-id-base64url.ts
 */

import { Pool } from "pg";

function base64ToBase64url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    console.log("Starting credentialID base64 → base64url conversion...");

    const { rows } = await client.query<{ id: string; credentialID: string }>(
      `SELECT "id", "credentialID" FROM "Passkey"`,
    );

    console.log(`Found ${rows.length} passkey(s)`);

    let updated = 0;
    for (const row of rows) {
      const converted = base64ToBase64url(row.credentialID);
      if (converted !== row.credentialID) {
        await client.query(
          `UPDATE "Passkey" SET "credentialID" = $1 WHERE "id" = $2`,
          [converted, row.id],
        );
        console.log(`  [updated] ${row.credentialID} → ${converted}`);
        updated++;
      }
    }

    console.log(`\nDone. ${updated} of ${rows.length} record(s) updated.`);
  } catch (error) {
    console.error("Conversion failed:", error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
