import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Cockroach hosted Git migration schema locks", () => {
  it.each([
    "20261002000000_add_git_repositories",
    "20261002010000_git_account_storage",
    "20261002190000_git_maintenance_fairness",
  ])("unlocks tables before modifying %s and restores the locks", (migration) => {
    const sql = readFileSync(new URL(`../apps/web/prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8");
    const unlocked = new Set<string>();
    for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
      const lock = /ALTER TABLE "([^"]+)" SET \(schema_locked = (true|false)\)/u.exec(statement);
      if (lock) {
        if (lock[2] === "false") unlocked.add(lock[1]);
        else { expect(unlocked.has(lock[1])).toBe(true); unlocked.delete(lock[1]); }
        continue;
      }
      const mutation = /ALTER TABLE "([^"]+)"|CREATE (?:UNIQUE )?INDEX .+? ON "([^"]+)"/u.exec(statement);
      if (mutation) expect(unlocked.has(mutation[1] ?? mutation[2]), statement).toBe(true);
    }
    expect([...unlocked]).toEqual([]);
  });
});
