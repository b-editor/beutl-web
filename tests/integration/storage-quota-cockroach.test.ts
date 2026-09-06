import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import {
  commitDedicatedStorageReservation,
  createDedicatedStorageReservation,
  createFileWithStorageQuota,
  renewDedicatedStorageReservation,
  setDbProvider,
} from "@beutl/db";

const connectionString = process.env.TEST_DATABASE_URL;
const describeWithCockroach = connectionString ? describe : describe.skip;

describeWithCockroach("Storage quota serializable concurrency (set TEST_DATABASE_URL to run)", () => {
  let prisma: PrismaClient;
  let admin: PrismaClient;
  let database: string;
  const userId = `quota-race-${crypto.randomUUID()}`;

  beforeAll(async () => {
    const base = new URL(connectionString!);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/defaultdb";
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: adminUrl.toString() }) });
    database = `codex_quota_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
    const databaseUrl = new URL(base);
    databaseUrl.pathname = `/${database}`;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl.toString() }) });
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "User" (
        "id" STRING PRIMARY KEY,
        "name" STRING,
        "email" STRING NOT NULL UNIQUE,
        "image" STRING,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp(),
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp(),
        "emailVerified" BOOL DEFAULT false
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TYPE "FileVisibility" AS ENUM ('PUBLIC', 'PRIVATE', 'DEDICATED')
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "File" (
        "id" STRING PRIMARY KEY DEFAULT gen_random_uuid()::STRING,
        "name" STRING NOT NULL,
        "size" INT8 NOT NULL,
        "mimeType" STRING NOT NULL,
        "objectKey" STRING NOT NULL,
        "reservationKind" STRING NOT NULL DEFAULT 'multipart',
        "userId" STRING NOT NULL,
        "sha256" STRING,
        "visibility" "FileVisibility" NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp(),
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp()
      )
    `);
    // sumFileSizeByUserId/countFilesByUserId exclude AI result relations.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "AiJob" (
        "id" STRING PRIMARY KEY,
        "resultFileId" STRING UNIQUE
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "StorageUpload" (
        "id" STRING PRIMARY KEY DEFAULT gen_random_uuid()::STRING,
        "userId" STRING NOT NULL,
        "objectKey" STRING NOT NULL,
        "reservationKind" STRING NOT NULL DEFAULT 'multipart',
        "uploadId" STRING,
        "name" STRING NOT NULL,
        "mimeType" STRING NOT NULL,
        "size" INT8 NOT NULL,
        "partSize" INT4 NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp(),
        "completedFileId" STRING UNIQUE,
        "abandonedAt" TIMESTAMP(3),
        "startState" STRING NOT NULL DEFAULT 'active',
        "creationLeaseUntil" TIMESTAMP(3),
        "creationLeaseToken" STRING,
        "completionState" STRING NOT NULL DEFAULT 'idle',
        "completionLeaseUntil" TIMESTAMP(3),
        "completionLeaseToken" STRING,
        "completionAttempts" INT4 NOT NULL DEFAULT 0,
        "completionLastError" STRING,
        "completionInterventionAt" TIMESTAMP(3),
        "completionRetryNotBefore" TIMESTAMP(3),
        "unknownProbeNotBefore" TIMESTAMP(3),
        "unknownProbeLeaseToken" STRING,
        "completionRevision" INT4 NOT NULL DEFAULT 0,
        "cleanupLeaseUntil" TIMESTAMP(3),
        "cleanupLeaseToken" STRING
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "AiStorageCleanup" (
        "objectKey" STRING PRIMARY KEY,
        "aiJobId" STRING,
        "leaseToken" STRING,
        "state" STRING NOT NULL,
        "notBefore" TIMESTAMP(3) NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp(),
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT current_timestamp()
      )
    `);
    setDbProvider(async () => prisma);
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  });

  beforeEach(async () => {
    await prisma.file.deleteMany({ where: { userId } });
    await prisma.storageUpload.deleteMany({ where: { userId } });
    await prisma.aiStorageCleanup.deleteMany({});
    await prisma.storageUpload.create({ data: {
      id: `reservation-${crypto.randomUUID()}`,
      userId,
      objectKey: "reserved",
      uploadId: "multipart-reserved",
      name: "reserved.bin",
      mimeType: "application/octet-stream",
      size: BigInt(9),
      partSize: 1,
      completionState: "idle",
    } });
    await prisma.aiStorageCleanup.createMany({ data: ["a", "b"].map((suffix) => ({
      objectKey: `objects/${suffix}`,
      aiJobId: null,
      leaseToken: null,
      state: "writing",
      notBefore: new Date(Date.now() + 15 * 60_000),
    })) });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" CASCADE`);
    await admin.$disconnect();
  });

  it("allows at most one last-byte, last-slot file alongside an active reservation", async () => {
    const create = (suffix: string) => createFileWithStorageQuota({
      userId,
      objectKey: `objects/${suffix}`,
      name: `${suffix}.bin`,
      size: 1,
      mimeType: "application/octet-stream",
      visibility: "DEDICATED",
      quotaBytes: BigInt(10),
      fileCountLimit: 2,
    });
    const outcomes = await Promise.all([create("a"), create("b")]);
    expect(outcomes.filter((outcome) => outcome.kind === "created")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === "tooManyFiles" || outcome.kind === "overQuota")).toHaveLength(1);

    const [files, reservation] = await Promise.all([
      prisma.file.count({ where: { userId } }),
      prisma.storageUpload.aggregate({ where: { userId, completedFileId: null }, _sum: { size: true } }),
    ]);
    expect(files).toBeLessThanOrEqual(1);
    expect(BigInt(reservation._sum.size ?? 0) + BigInt(files)).toBeLessThanOrEqual(10);
  }, 120_000);

  it("serializes a dedicated reservation against a competing multipart-sized commit", async () => {
    await prisma.file.deleteMany({ where: { userId } });
    await prisma.storageUpload.deleteMany({ where: { userId } });
    await prisma.aiStorageCleanup.deleteMany({});
    const dedicated = () => createDedicatedStorageReservation({
      userId,
      id: `dedicated-${crypto.randomUUID()}`,
      objectKey: `objects/dedicated-${crypto.randomUUID()}`,
      name: "dedicated.bin",
      mimeType: "application/octet-stream",
      size: BigInt(10),
      quotaBytes: BigInt(10),
      fileCountLimit: 1,
    });
    const multipartObjectKey = `objects/multipart-${crypto.randomUUID()}`;
    await prisma.aiStorageCleanup.create({
      data: {
        objectKey: multipartObjectKey,
        aiJobId: null,
        leaseToken: null,
        state: "writing",
        notBefore: new Date(Date.now() + 15 * 60_000),
      },
    });
    const multipartCommit = () => createFileWithStorageQuota({
      userId,
      objectKey: multipartObjectKey,
      name: "multipart.bin",
      size: 10,
      mimeType: "application/octet-stream",
      visibility: "DEDICATED",
      quotaBytes: BigInt(10),
      fileCountLimit: 1,
    });
    const [reservation, commit] = await Promise.all([dedicated(), multipartCommit()]);
    expect([reservation.kind, commit.kind].filter((kind) => kind === "reserved" || kind === "created")).toHaveLength(1);
    expect([reservation.kind, commit.kind].some((kind) => kind === "overQuota" || kind === "tooManyFiles")).toBe(true);
    const [files, reserved] = await Promise.all([
      prisma.file.count({ where: { userId } }),
      prisma.storageUpload.aggregate({ where: { userId, completedFileId: null }, _sum: { size: true } }),
    ]);
    expect(files + (await prisma.storageUpload.count({ where: { userId, completedFileId: null, abandonedAt: null } }))).toBeLessThanOrEqual(1);
    expect(BigInt(reserved._sum.size ?? 0) + BigInt(files)).toBeLessThanOrEqual(10);
  }, 120_000);

  it("publishes, renews, and consumes the dedicated write lease", async () => {
    await prisma.file.deleteMany({ where: { userId } });
    await prisma.storageUpload.deleteMany({ where: { userId } });
    await prisma.aiStorageCleanup.deleteMany({});
    const objectKey = `objects/leased-${crypto.randomUUID()}`;
    const reserved = await createDedicatedStorageReservation({
      userId,
      id: `leased-${crypto.randomUUID()}`,
      objectKey,
      name: "leased.bin",
      mimeType: "application/octet-stream",
      size: BigInt(1),
      quotaBytes: BigInt(10),
      fileCountLimit: 10,
    });
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind !== "reserved") throw new Error("reservation was rejected");
    const leaseToken = reserved.reservation.creationLeaseToken!;
    const initialLeaseUntil = reserved.reservation.creationLeaseUntil!;
    const renewedUntil = new Date(initialLeaseUntil.getTime() + 60_000);
    await expect(renewDedicatedStorageReservation({
      id: reserved.reservation.id,
      userId,
      objectKey,
      leaseToken,
      expectedLeaseUntil: initialLeaseUntil,
      leaseUntil: renewedUntil,
      now: new Date(initialLeaseUntil.getTime() - 1),
    })).resolves.toBe(true);
    const committed = await commitDedicatedStorageReservation({
      id: reserved.reservation.id,
      userId,
      objectKey,
      leaseToken,
      sha256: "a".repeat(64),
    });
    expect(committed.kind).toBe("created");
    const row = await prisma.storageUpload.findUnique({
      where: { id: reserved.reservation.id },
    });
    expect(row).toMatchObject({
      completionState: "settled",
      creationLeaseToken: null,
      creationLeaseUntil: null,
      completionLeaseToken: null,
      completionLeaseUntil: null,
    });
    await expect(prisma.aiStorageCleanup.count({ where: { objectKey } })).resolves.toBe(0);
  }, 120_000);
});
