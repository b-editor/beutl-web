import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { setDbProvider, type PrismaTransaction } from "@beutl/db";
import { startAiJobTransaction } from "../../packages/api/src/ai/transaction";

const connectionString = process.env.TEST_DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase("AI transaction budget on CockroachDB", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    setDbProvider(async () => prisma);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  // This models accumulated database round-trip latency, not provider work.
  // It deliberately exceeds the observed production failure's five-second
  // budget and performs no writes, even in the success case.
  const slowDatabaseWork = async (tx: PrismaTransaction) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await new Promise(resolve => setTimeout(resolve, 5_500));
    return await tx.$queryRaw<{ value: number }[]>`SELECT 1::INT4 AS value`;
  };

  it("reproduces expiration with Prisma's unchanged default budget", async () => {
    await expect(prisma.$transaction(slowDatabaseWork)).rejects.toMatchObject({ code: "P2028" });
  }, 20_000);

  it("completes the same work with the bounded AI job budget", async () => {
    await expect(startAiJobTransaction(slowDatabaseWork)).resolves.toEqual([{ value: 1 }]);
  }, 40_000);
});
