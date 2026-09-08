import { beforeEach, describe, expect, it } from "vitest";
import { retrieveStorageFilesByUserId, setDbProvider } from "@beutl/db";
import { STORAGE_LIST_MAX_FILES, STORAGE_PAID_FILE_COUNT_LIMIT } from "@beutl/core";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const USER_ID = "listing-user";

// The storage page receives the whole listing and sorts, searches, and pages
// it in the browser. A paid account may hold far more files than a page can
// carry, so the listing is the newest STORAGE_LIST_MAX_FILES and the page
// says how many more there are.
describe("bounded storage listing", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;

  beforeEach(() => {
    memory = createInMemoryPrisma();
    setDbProvider(async () => memory.prisma as never);
  });

  it("keeps the page bound below the paid file limit", () => {
    expect(STORAGE_LIST_MAX_FILES).toBeLessThan(STORAGE_PAID_FILE_COUNT_LIMIT);
  });

  it("returns the newest files up to the limit", async () => {
    for (let index = 0; index < 12; index++) {
      memory.state.files.set(`f-${index}`, {
        id: `f-${index}`,
        userId: USER_ID,
        objectKey: `f-${index}`,
        name: `f-${index}`,
        size: 1,
        mimeType: "application/octet-stream",
        visibility: "PRIVATE",
        sha256: null,
        createdAt: new Date(1_000 + index),
        updatedAt: new Date(1_000 + index),
      } as never);
    }

    const listed = await retrieveStorageFilesByUserId({ userId: USER_ID, limit: 10 });

    expect(listed).toHaveLength(10);
    expect(listed.map((file) => file.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `f-${11 - index}`),
    );
    expect(await retrieveStorageFilesByUserId({ userId: USER_ID })).toHaveLength(12);
  });
});
