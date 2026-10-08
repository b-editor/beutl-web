import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  afterCallbacks: [] as (() => unknown)[],
  clients: [] as { ended: boolean }[],
}));

vi.mock("@prisma/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@prisma/client")>(),
  // Like pg's Pool after end(): the client refuses every later query.
  PrismaClient: class {
    ended = false;
    constructor() { state.clients.push(this); }
    async $disconnect() { this.ended = true; }
    async query(label: string) {
      if (this.ended) throw new Error("Cannot use a pool after calling end on the pool");
      return label;
    }
  },
}));

import { getDb } from "@beutl/db";

let withOwnPrismaClient: typeof import("../../apps/web/src/prisma").withOwnPrismaClient;

beforeAll(async () => {
  // prisma.ts resolves these from apps/web, so mock them at that path.
  const fromWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
  vi.doMock(fromWeb.resolve("next/server"), () => ({
    after: (callback: () => unknown) => { state.afterCallbacks.push(callback); },
  }));
  vi.doMock(fromWeb.resolve("@opennextjs/cloudflare"), () => ({
    getCloudflareContext: async () => ({
      env: { BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://own-client-test" } },
    }),
  }));
  vi.doMock(fromWeb.resolve("@prisma/adapter-pg"), () => ({ PrismaPg: class {} }));
  ({ withOwnPrismaClient } = await import("../../apps/web/src/prisma"));
});

type FakeClient = { ended: boolean; query(label: string): Promise<string> };

async function closeResponse() {
  await Promise.all(state.afterCallbacks.splice(0).map((callback) => callback()));
}

describe("work that outlives the response", () => {
  beforeEach(() => {
    state.afterCallbacks.length = 0;
    state.clients.length = 0;
  });

  it("finishes a background recompute after the request's client closes", async () => {
    const request = await getDb() as unknown as FakeClient;
    let pageAnswered!: () => void;
    const recompute = withOwnPrismaClient(async (prisma) => {
      const own = prisma as unknown as FakeClient;
      await own.query("packages");
      await new Promise<void>((resolve) => { pageAnswered = resolve; });
      return own.query("publishers");
    });
    await vi.waitFor(() => expect(pageAnswered).toBeTypeOf("function"));

    await closeResponse();
    expect(request.ended).toBe(true);
    pageAnswered();

    await expect(recompute).resolves.toBe("publishers");
    expect(state.clients).toHaveLength(2);
    expect(state.clients[1].ended).toBe(true);
  });

  it("does not hand its client to the response's after()", async () => {
    await withOwnPrismaClient(async () => undefined);
    expect(state.afterCallbacks).toHaveLength(0);
    expect(state.clients[0].ended).toBe(true);
  });

  it("releases its client when the work fails", async () => {
    await expect(withOwnPrismaClient(async () => {
      throw new Error("query failed");
    })).rejects.toThrow("query failed");
    expect(state.clients[0].ended).toBe(true);
  });

  it("recomputes the landing packages on a client of their own", () => {
    const storeUtils = readFileSync(
      new URL("../../apps/web/src/lib/store-utils.ts", import.meta.url),
      "utf8",
    );
    const cached = storeUtils.slice(storeUtils.indexOf("unstable_cache("));
    expect(cached).toMatch(
      /^unstable_cache\(\s*\(take: number\) =>\s*withOwnPrismaClient\(\(prisma\) => retrieveLatestPublishedPackages\(\{ take, prisma \}\)\)/u,
    );
  });
});
