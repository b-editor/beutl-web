import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = readFile(new URL("../../apps/web/prisma/migrations/20261004000000_add_git_access_tokens/migration.sql", import.meta.url), "utf8");
const schema = readFile(new URL("../../apps/web/prisma/schema.prisma", import.meta.url), "utf8");

describe("Git access token migration", () => {
  it("creates indexes and the repository key only while both tables are unlocked, then relocks them", async () => {
    const sql = await migration;
    const unlocks = ["GitAccessToken", "GitRepository"].map((table) => sql.indexOf(`ALTER TABLE "${table}" SET (schema_locked = false)`));
    const relocks = ["GitAccessToken", "GitRepository"].map((table) => sql.lastIndexOf(`ALTER TABLE "${table}" SET (schema_locked = true)`));
    expect(unlocks.every((index) => index > sql.indexOf('CREATE TABLE "GitAccessToken"'))).toBe(true);
    for (const statement of ['CREATE UNIQUE INDEX "GitAccessToken_tokenHash_key"', 'CREATE INDEX "GitAccessToken_repoId_revokedAt_idx"',
      'ADD CONSTRAINT "GitAccessToken_repoId_fkey"']) {
      const index = sql.indexOf(statement);
      expect(index, statement).toBeGreaterThan(Math.max(...unlocks));
      expect(index, statement).toBeLessThan(Math.min(...relocks));
    }
    expect(sql).toContain('REFERENCES "GitRepository"("id") ON DELETE CASCADE');
  });

  it("matches the Prisma model's columns", async () => {
    const model = /model GitAccessToken \{([\s\S]*?)\n\}/u.exec(await schema)![1];
    const columns = [...model.matchAll(/^\s+(\w+)\s+(String|DateTime)\??/gmu)].map((match) => match[1]);
    const sql = await migration;
    for (const column of columns) expect(sql, column).toContain(`"${column}"`);
    expect(columns).toEqual(["id", "repoId", "ownerId", "name", "scope", "tokenHash", "hint", "createdAt", "lastUsedAt", "revokedAt"]);
  });
});
