import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeAuthEmailSendLimits,
  pruneAuthEmailSendLimits,
  revokeAllUserSessions,
  setDbProvider,
  startRetryableTransaction,
  updateUserEmail,
} from "@beutl/db";
import {
  consumeConfirmationToken,
  issueConfirmationToken,
  validateConfirmationToken,
} from "../../apps/web/src/lib/confirmation-token-flow";

const { Client } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("pg");
const connectionString = process.env.TEST_DATABASE_URL;
const describeWithCockroach = connectionString ? describe : describe.skip;

describeWithCockroach("authentication-email security on CockroachDB", () => {
  const database = `auth_email_security_${randomUUID().replaceAll("-", "")}`;
  let admin: InstanceType<typeof Client>;
  let client: InstanceType<typeof Client>;
  let prisma: PrismaClient;
  let created = false;
  let migratedPurposes: string[];
  let tableDefinition: string;

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
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString(), max: 12 }),
    });
    setDbProvider(async () => prisma);
    vi.stubEnv("AUTH_SECRET", "local-auth-email-integration-secret");
    await client.query(`CREATE TABLE "User" (
      "id" STRING PRIMARY KEY, "name" STRING, "email" STRING NOT NULL UNIQUE, "image" STRING,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp(), "updatedAt" TIMESTAMP(3) NOT NULL,
      "emailVerified" BOOL DEFAULT false, "storageRevision" INT4 NOT NULL DEFAULT 0
    )`);
    await client.query(`CREATE TABLE "Session" (
      "id" STRING PRIMARY KEY, "token" STRING NOT NULL UNIQUE, "userId" STRING NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
      "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp(),
      "updatedAt" TIMESTAMP(3) NOT NULL, "ipAddress" STRING, "userAgent" STRING
    )`);
    await client.query(`CREATE TABLE "RefreshTokenFamily" (
      "id" STRING PRIMARY KEY, "userId" STRING NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
      "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp(), "updatedAt" TIMESTAMP(3) NOT NULL
    )`);
    await client.query(
      `CREATE TYPE "ConfirmationTokenPurpose" AS ENUM ('EMAIL_UPDATE', 'ACCOUNT_DELETE')`,
    );
    await client.query(`CREATE TABLE "ConfirmationToken" (
      "userId" STRING NOT NULL REFERENCES "User"("id") ON DELETE CASCADE, "identifier" STRING NOT NULL,
      "token" STRING NOT NULL, "expires" TIMESTAMP(3) NOT NULL, "purpose" "ConfirmationTokenPurpose" NOT NULL,
      PRIMARY KEY ("identifier", "token")
    )`);
    await client.query(
      `INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('legacy', 'legacy@example.com', current_timestamp())`,
    );
    await client.query(`INSERT INTO "ConfirmationToken" VALUES
      ('legacy', 'new@example.com', 'legacy-email', current_timestamp() + INTERVAL '1 hour', 'EMAIL_UPDATE'),
      ('legacy', 'legacy@example.com', 'legacy-deletion', current_timestamp() + INTERVAL '1 hour', 'ACCOUNT_DELETE')`);
    await client.query('ALTER TABLE "Session" SET (schema_locked = true)');
    await client.query('ALTER TABLE "ConfirmationToken" SET (schema_locked = true)');
    const migration = await readFile(
      new URL(
        "../../apps/web/prisma/migrations/20261010000000_secure_email_changes_and_sends/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of migration.split(";").filter((part) => part.trim()))
      await client.query(statement);
    migratedPurposes = (await client.query('SELECT "purpose" FROM "ConfirmationToken"')).rows.map(
      (row: { purpose: string }) => row.purpose,
    );
    tableDefinition = (await client.query('SHOW CREATE TABLE "ConfirmationToken"')).rows[0]
      .create_statement;
  }, 90000);

  beforeEach(async () => {
    await prisma.confirmationToken.deleteMany();
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
    await prisma.authEmailRateLimit.deleteMany();
    await prisma.user.create({
      data: { id: "owner", email: "owner@example.com", emailVerified: true },
    });
    await prisma.session.create({
      data: {
        id: "original-session",
        token: "original-token",
        userId: "owner",
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma?.$disconnect();
    await client?.end();
    if (admin) {
      if (created) await admin.query(`DROP DATABASE "${database}" CASCADE`);
      await admin.end();
    }
  });

  const issue = (purpose: "EMAIL_UPDATE" | "EMAIL_UPDATE_APPROVAL" = "EMAIL_UPDATE") =>
    issueConfirmationToken({
      identifier: "new@example.com",
      userId: "owner",
      purpose,
      sessionId: "original-session",
      sourceEmail: "owner@example.com",
    });
  const consume = (token: string) =>
    consumeConfirmationToken({
      token,
      identifier: "new@example.com",
      purpose: "EMAIL_UPDATE",
      authorizedUserId: "owner",
      authorizedSessionId: "original-session",
    });

  it("migrates locked tables, invalidates old email links and preserves account-deletion links", () => {
    expect(migratedPurposes).toEqual(["ACCOUNT_DELETE"]);
    expect(tableDefinition).toContain("schema_locked = true");
    expect(tableDefinition).toContain("ON DELETE CASCADE");
    expect(tableDefinition).toContain("ConfirmationToken_sessionId_idx");
  });

  it("allows only five concurrent sends against shared counters", async () => {
    const limits = [
      { key: "same-client", max: 20, windowMilliseconds: 60000 },
      { key: "same-recipient", max: 5, windowMilliseconds: 60000 },
    ];
    const results = await Promise.all(
      Array.from({ length: 24 }, () => consumeAuthEmailSendLimits(limits)),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(
      (await prisma.authEmailRateLimit.findUniqueOrThrow({ where: { key: "same-client" } })).count,
    ).toBe(5);
    expect(
      (await prisma.authEmailRateLimit.findUniqueOrThrow({ where: { key: "same-recipient" } }))
        .count,
    ).toBe(5);
  }, 30000);

  it("does not spend unrelated quota when any limit refuses the send", async () => {
    const now = new Date();
    await consumeAuthEmailSendLimits([{ key: "full", max: 1, windowMilliseconds: 60000 }], now);
    expect(
      await consumeAuthEmailSendLimits(
        [
          { key: "available", max: 20, windowMilliseconds: 60000 },
          { key: "full", max: 1, windowMilliseconds: 60000 },
        ],
        now,
      ),
    ).toMatchObject({ allowed: false });
    expect(await prisma.authEmailRateLimit.findUnique({ where: { key: "available" } })).toBeNull();
  });

  it("resets expired counters and prunes expired rows in bounded batches", async () => {
    const now = new Date();
    await consumeAuthEmailSendLimits([{ key: "reset", max: 1, windowMilliseconds: 1000 }], now);
    expect(
      await consumeAuthEmailSendLimits(
        [{ key: "reset", max: 1, windowMilliseconds: 1000 }],
        new Date(now.getTime() + 1000),
      ),
    ).toEqual({ allowed: true });
    await prisma.authEmailRateLimit.createMany({
      data: Array.from({ length: 120 }, (_, index) => ({
        key: `expired-${index}`,
        count: 1,
        expiresAt: new Date(now.getTime() - 1000),
      })),
    });
    await pruneAuthEmailSendLimits(now);
    expect(await prisma.authEmailRateLimit.count()).toBe(21);
  });

  it("cannot issue a bound link after its source session was revoked", async () => {
    await revokeAllUserSessions({ userId: "owner" });
    await expect(issue()).rejects.toThrow("Email change session is no longer valid");
    expect(await prisma.confirmationToken.count()).toBe(0);
  });

  it("cascades both approval and confirmation links when Better Auth's session row is deleted", async () => {
    await issue("EMAIL_UPDATE_APPROVAL");
    const token = await issue();
    expect(await prisma.confirmationToken.count()).toBe(2);
    await prisma.session.delete({ where: { id: "original-session" } });
    expect(await prisma.confirmationToken.count()).toBe(0);
    expect(await consume(token)).toMatchObject({ valid: false });
  });

  it("does not let another signed-in account claim a change link", async () => {
    const token = await issue();
    await prisma.user.create({ data: { id: "other", email: "other@example.com" } });
    await prisma.session.create({
      data: {
        id: "other-session",
        token: "other-token",
        userId: "other",
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    expect(
      await consumeConfirmationToken({
        token,
        identifier: "new@example.com",
        purpose: "EMAIL_UPDATE",
        authorizedUserId: "other",
        authorizedSessionId: "other-session",
      }),
    ).toMatchObject({ valid: false });
    expect(await prisma.confirmationToken.count()).toBe(1);
    expect(await consume(token)).toMatchObject({ valid: true });
    expect(await consume(token)).toMatchObject({ valid: false });
  });

  it("refuses expired source sessions and superseded email addresses", async () => {
    const token = await issue();
    await prisma.session.update({
      where: { id: "original-session" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await consume(token)).toMatchObject({ valid: false });
    await prisma.session.update({
      where: { id: "original-session" },
      data: { expiresAt: new Date(Date.now() + 86400000) },
    });
    await prisma.user.update({
      where: { id: "owner" },
      data: { email: "replacement@example.com" },
    });
    expect(await consume(token)).toMatchObject({ valid: false });
  });

  it("rechecks revocation inside the transaction after the initial token validation", async () => {
    const token = await issue();
    let ready!: () => void;
    let resume!: () => void;
    const observed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const continued = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let first = true;
    const update = startRetryableTransaction(
      async (tx) => {
        const valid = await validateConfirmationToken({
          token,
          identifier: "new@example.com",
          purpose: "EMAIL_UPDATE",
          prisma: tx,
        });
        if (!valid.valid) return false;
        if (first) {
          first = false;
          ready();
          await continued;
        }
        const claimed = await consumeConfirmationToken({
          token,
          identifier: "new@example.com",
          purpose: "EMAIL_UPDATE",
          authorizedUserId: "owner",
          authorizedSessionId: "original-session",
          prisma: tx,
        });
        if (!claimed.valid) return false;
        await updateUserEmail({
          userId: "owner",
          email: "new@example.com",
          expectedEmail: "owner@example.com",
          prisma: tx,
        });
        return true;
      },
      { isolationLevel: "Serializable" },
    );
    await observed;
    try {
      await startRetryableTransaction((tx) =>
        revokeAllUserSessions({ userId: "owner", prisma: tx }),
      );
    } finally {
      resume();
    }
    expect(await update).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "owner" } })).email).toBe(
      "owner@example.com",
    );
  }, 30000);
});
