/**
 * Account テーブルから providerId が "passkey" のレコードを削除するスクリプト
 *
 * 使用方法:
 * npx tsx scripts/delete-passkey-accounts.ts
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
    // 削除前に対象レコード数を確認
    const countResult = await client.query(
      `SELECT COUNT(*) FROM "Account" WHERE "providerId" = 'passkey'`
    );
    const count = parseInt(countResult.rows[0].count, 10);
    console.log(`Found ${count} Account record(s) with providerId = 'passkey'`);

    if (count === 0) {
      console.log("Nothing to delete.");
      return;
    }

    // 削除実行
    const deleteResult = await client.query(
      `DELETE FROM "Account" WHERE "providerId" = 'passkey'`
    );
    console.log(`Deleted ${deleteResult.rowCount} record(s).`);
  } catch (error) {
    console.error("Failed to delete passkey accounts:", error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
