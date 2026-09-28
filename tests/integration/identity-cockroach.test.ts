import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { findUserIdByUserName, ProfileUserNameTakenError, setDbProvider, upsertProfile } from "@beutl/db";
import account from "../../packages/api/src/v1/account";

const { Client } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("pg");
const connectionString = process.env.TEST_DATABASE_URL;
const describeWithCockroach = connectionString ? describe : describe.skip;

describeWithCockroach("publisher and native authorization identities on CockroachDB", () => {
  const database = `profile_identity_${randomUUID().replaceAll("-", "")}`;
  let admin: InstanceType<typeof Client>;
  let client: InstanceType<typeof Client>;
  let prisma: PrismaClient;
  let migration: string;
  let created = false;

  async function applyMigration() {
    // Cockroach requires schema_locked changes in their own implicit transactions,
    // as when Prisma or the cockroach SQL CLI executes the migration statements.
    const [preflight, ddl] = migration.split("END $$;");
    await client.query(`${preflight}END $$;`);
    for (const statement of ddl.split(";").filter((part) => part.trim())) {
      await client.query(statement);
    }
  }

  beforeAll(async () => {
    const url = new URL(connectionString!);
    url.pathname = "/defaultdb";
    admin = new Client({ connectionString: url.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    url.pathname = `/${database}`;
    client = new Client({ connectionString: url.toString() });
    await client.connect();
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
    setDbProvider(async () => prisma);
    vi.stubEnv("JWT_SECRET", "local-cockroach-test-secret");
    vi.stubEnv("JWT_ISSUER", "");
    vi.stubEnv("JWT_AUDIENCE", "");
    migration = await readFile(new URL(
      "../../apps/web/prisma/migrations/20260928010000_unique_profile_user_names/migration.sql",
      import.meta.url,
    ), "utf8");
    await client.query(`CREATE TABLE "Profile" (
      "userId" STRING PRIMARY KEY, "userName" STRING NOT NULL,
      "displayName" STRING NOT NULL, "bio" STRING, "iconFileId" STRING
    )`);
    await client.query(`INSERT INTO "Profile" VALUES ('original', 'Publisher', 'Original', NULL, NULL)`);
    await client.query('ALTER TABLE "Profile" SET (schema_locked = true)');
    await applyMigration();
    await client.query(`CREATE TABLE "User" ("id" STRING PRIMARY KEY)`);
    await client.query(`INSERT INTO "User" VALUES ('native-owner')`);
    await client.query(`CREATE TABLE "NativeAppAuth" (
      "id" STRING PRIMARY KEY, "sessionId" STRING NOT NULL, "continueUrl" STRING NOT NULL,
      "userId" STRING REFERENCES "User" ("id"), "code" STRING, "codeExpires" TIMESTAMP(3)
    )`);
    await client.query(`CREATE TABLE "RefreshTokenFamily" (
      "id" STRING PRIMARY KEY, "userId" STRING NOT NULL REFERENCES "User" ("id"),
      "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp(), "updatedAt" TIMESTAMP(3) NOT NULL
    )`);
    await client.query(`CREATE TABLE "NativeRefreshToken" (
      "token" STRING PRIMARY KEY, "userId" STRING NOT NULL REFERENCES "User" ("id"),
      "refreshTokenFamilyId" STRING NOT NULL REFERENCES "RefreshTokenFamily" ("id") ON DELETE CASCADE,
      "expiresAt" TIMESTAMP(3) NOT NULL, "refreshTokenConsumedAt" TIMESTAMP(3), "refreshTokenReplacedByToken" STRING,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp(), "updatedAt" TIMESTAMP(3) NOT NULL
    )`);
  }, 90_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await prisma?.$disconnect();
    await client?.end();
    if (admin) {
      if (created) await admin.query(`DROP DATABASE "${database}" CASCADE`);
      await admin.end();
    }
  });

  it("preserves existing spelling and blocks case variants even for direct SQL writers", async () => {
    expect((await prisma.profile.findUniqueOrThrow({ where: { userId: "original" } })).userName).toBe("Publisher");
    await expect(client.query(`INSERT INTO "Profile" ("userId", "userName", "displayName") VALUES ('imposter', 'PUBLISHER', 'Other')`))
      .rejects.toMatchObject({ code: "23505" });
    const { rows } = await client.query('SHOW CREATE TABLE "Profile"');
    expect(rows[0].create_statement).toContain("schema_locked = true");
    expect(rows[0].create_statement).toContain("Profile_userName_lower_key");
  });

  it("allows the owner to change casing but refuses another owner", async () => {
    await expect(upsertProfile({ userId: "original", userName: "publisher", displayName: "Original" }))
      .resolves.toMatchObject({ userName: "publisher" });
    await expect(upsertProfile({ userId: "imposter", userName: "Publisher", displayName: "Other" }))
      .rejects.toBeInstanceOf(ProfileUserNameTakenError);
  });

  it("settles concurrent claims through the DB constraint with only one winner", async () => {
    const results = await Promise.allSettled([
      upsertProfile({ userId: "racer-1", userName: "NewPublisher", displayName: "One" }),
      upsertProfile({ userId: "racer-2", userName: "NEWPUBLISHER", displayName: "Two" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason).toBeInstanceOf(ProfileUserNameTakenError);
    expect(await prisma.profile.count({ where: { userName: { equals: "newpublisher", mode: "insensitive" } } })).toBe(1);
  });

  it("treats underscores literally when checking and looking up an identity", async () => {
    await upsertProfile({ userId: "literal-one", userName: "literalOne", displayName: "One" });
    expect(await findUserIdByUserName({ name: "literal_ne" })).toBeNull();
    await expect(upsertProfile({ userId: "literal-two", userName: "literal_ne", displayName: "Two" }))
      .resolves.toMatchObject({ userName: "literal_ne" });
    expect(await findUserIdByUserName({ name: "LITERAL_NE" })).toEqual({ userId: "literal-two" });
    expect(await findUserIdByUserName({ name: "LITERALONE" })).toEqual({ userId: "literal-one" });
  });

  it("refuses existing duplicates before unlocking or renaming anything, then supports a retry", async () => {
    await client.query('CREATE SCHEMA legacy_profiles');
    await client.query('SET search_path TO legacy_profiles');
    try {
      await client.query(`CREATE TABLE "Profile" ("userId" STRING PRIMARY KEY, "userName" STRING NOT NULL)`);
      await client.query(`INSERT INTO "Profile" VALUES ('one', 'Alice'), ('two', 'ALICE')`);
      await client.query('ALTER TABLE "Profile" SET (schema_locked = true)');
      await expect(applyMigration()).rejects.toThrow("duplicate case-insensitive user names");
      const { rows } = await client.query('SHOW CREATE TABLE "Profile"');
      expect(rows[0].create_statement).toContain("schema_locked = true");
      expect((await client.query('SELECT "userName" FROM "Profile" ORDER BY "userId"')).rows)
        .toEqual([{ userName: "Alice" }, { userName: "ALICE" }]);
      await client.query(`UPDATE "Profile" SET "userName" = 'Alice2' WHERE "userId" = 'two'`);
      await applyMigration();
      await applyMigration();
      await expect(client.query(`INSERT INTO "Profile" VALUES ('three', 'alice')`))
        .rejects.toMatchObject({ code: "23505" });
    } finally {
      await client.query('SET search_path TO public');
      await client.query('DROP SCHEMA legacy_profiles CASCADE');
    }
  }, 60_000);

  const exchange = (sessionId: string) => account.request("/code2jwt", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, code: "one-use-code" }),
  });
  async function authorize(id: string) {
    await prisma.nativeAppAuth.create({ data: {
      id, sessionId: id, continueUrl: "http://localhost:43123/callback",
      userId: "native-owner", code: "one-use-code", codeExpires: new Date(Date.now() + 60_000),
    } });
  }

  it("mints only one token family during concurrent real database exchanges", async () => {
    await authorize("concurrent-auth");
    const before = await prisma.refreshTokenFamily.count();
    const responses = await Promise.all([exchange("concurrent-auth"), exchange("concurrent-auth")]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(await prisma.refreshTokenFamily.count()).toBe(before + 1);
    expect(await prisma.nativeAppAuth.count({ where: { id: "concurrent-auth" } })).toBe(0);
  }, 30_000);

  it("rolls back the consumed code and new family when the token insert fails", async () => {
    await authorize("rollback-auth");
    const before = await prisma.refreshTokenFamily.count();
    const original = prisma.$transaction.bind(prisma);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const transaction = vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (callback: (tx: unknown) => unknown) =>
      original(async (tx) => {
        vi.spyOn(tx.nativeRefreshToken, "create").mockRejectedValueOnce(new Error("injected token write failure"));
        return callback(tx);
      })) as never);
    try {
      expect((await exchange("rollback-auth")).status).toBe(500);
    } finally {
      transaction.mockRestore();
      errors.mockRestore();
    }
    expect(await prisma.nativeAppAuth.count({ where: { id: "rollback-auth" } })).toBe(1);
    expect(await prisma.refreshTokenFamily.count()).toBe(before);
    expect((await exchange("rollback-auth")).status).toBe(200);
  }, 30_000);
});
