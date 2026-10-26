import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  afterCallbacks: [] as (() => unknown)[],
  clients: [] as { ended: boolean }[],
  readStarted: Promise.withResolvers<void>(),
  resumeRead: Promise.withResolvers<void>(),
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
    file = {
      findFirst: async () => {
        state.readStarted.resolve();
        await state.resumeRead.promise;
        // A relation query can need the pool again after its first I/O.
        await this.query("file relations");
        return null;
      },
    };
  },
}));

vi.mock("@/lib/better-auth", () => ({ auth: { api: { getSession: vi.fn() } } }));

import { getDb, runWithSharedDb } from "@beutl/db";

let withOwnPrismaClient: typeof import("../../apps/web/src/prisma").withOwnPrismaClient;
let contentRoute: typeof import("../../apps/web/src/app/api/contents/[fileId]/route");

beforeAll(async () => {
  // prisma.ts resolves these from apps/web, so mock them at that path.
  const fromWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
  vi.doMock(fromWeb.resolve("next/server"), async (importOriginal) => ({
    ...await importOriginal<typeof import("next/server")>(),
    after: (callback: () => unknown) => { state.afterCallbacks.push(callback); },
  }));
  vi.doMock(fromWeb.resolve("@opennextjs/cloudflare"), () => ({
    getCloudflareContext: async () => ({
      env: { BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://own-client-test" } },
    }),
  }));
  vi.doMock(fromWeb.resolve("@prisma/adapter-pg"), () => ({ PrismaPg: class {} }));
  ({ withOwnPrismaClient } = await import("../../apps/web/src/prisma"));
  contentRoute = await import("../../apps/web/src/app/api/contents/[fileId]/route");
});

type FakeClient = { ended: boolean; query(label: string): Promise<string> };

async function closeResponse() {
  await Promise.all(state.afterCallbacks.splice(0).map((callback) => callback()));
}

describe("work that outlives the response", () => {
  beforeEach(() => {
    state.afterCallbacks.length = 0;
    state.clients.length = 0;
    state.readStarted = Promise.withResolvers<void>();
    state.resumeRead = Promise.withResolvers<void>();
  });

  it("shares an action client and disconnects it only after the response", async () => {
    const client = await runWithSharedDb(async () => {
      const [first, second] = await Promise.all([getDb(), getDb()]);
      expect(first).toBe(second);
      return first as unknown as FakeClient;
    });

    expect(state.clients).toHaveLength(1);
    expect(state.afterCallbacks).toHaveLength(1);
    expect(client.ended).toBe(false);
    await closeResponse();
    expect(client.ended).toBe(true);
  });

  it("retains the action's client for storage work already started in its scope", async () => {
    let resume!: () => void;
    const pending = new Promise<void>((resolve) => { resume = resolve; });
    let deferred!: Promise<FakeClient>;
    const actionClient = await runWithSharedDb(async () => {
      const client = await getDb() as unknown as FakeClient;
      deferred = (async () => {
        await pending;
        return await getDb() as unknown as FakeClient;
      })();
      return client;
    });

    // The subsequent render leaves the action scope and owns a separate client.
    const renderClient = await getDb() as unknown as FakeClient;
    expect(renderClient).not.toBe(actionClient);
    resume();
    expect(await deferred).toBe(actionClient);
    expect(actionClient.ended).toBe(false);
    expect(state.clients).toHaveLength(2);
    await closeResponse();
    expect(actionClient.ended).toBe(true);
    expect(renderClient.ended).toBe(true);
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

  it.each(["GET", "HEAD"] as const)("keeps content %s queries alive across an early disconnect, then releases the pool", async (method) => {
    const visitor = new AbortController();
    const result = contentRoute[method](new Request("https://beutl.example/api/contents/missing", {
      method, signal: visitor.signal,
    }) as Parameters<typeof contentRoute.GET>[0], { params: Promise.resolve({ fileId: "missing" }) });
    await state.readStarted.promise;
    visitor.abort();
    // Next's onClose invokes after() even while the route is still awaiting I/O.
    await closeResponse();
    state.resumeRead.resolve();
    expect((await result).status).toBe(404);
    expect(state.clients).toHaveLength(1);
    expect(state.clients[0].ended).toBe(true);
    expect(state.afterCallbacks).toHaveLength(0);
  });

  it("recomputes the landing packages on a client of their own", () => {
    const storeUtils = readFileSync(
      new URL("../../apps/web/src/lib/store-utils.ts", import.meta.url),
      "utf8",
    );
    const cached = storeUtils.slice(storeUtils.indexOf("unstable_cache("));
    expect(cached).toMatch(
      /^unstable_cache\(\s*\(take: number, lang: string\) =>\s*withOwnPrismaClient\(\(prisma\) => retrieveLatestPublishedPackages\(\{ take, lang, prisma \}\)\)/u,
    );
  });
});
