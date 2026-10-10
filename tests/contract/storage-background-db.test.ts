import { createRequire } from "node:module";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithSharedDb } from "@beutl/db";
import { createInMemoryPrisma } from "../stubs/in-memory-prisma";

const state = vi.hoisted(() => ({
  afterCallbacks: [] as (() => unknown)[],
  clients: [] as { ended: boolean }[],
  db: {} as Record<string, unknown>,
  getContext: vi.fn(),
}));

vi.mock("@prisma/client", async (original) => ({
  ...await original<typeof import("@prisma/client")>(),
  PrismaClient: class {
    ended = false;
    constructor() {
      state.clients.push(this);
      // Storage helpers enter $transaction through their own client's pool.
      // Refuse new transactions after its response cleanup disconnects it.
      return new Proxy(this, {
        get(target, property, receiver) {
          if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
          const value = Reflect.get(state.db, property);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (target.ended) throw new Error("Cannot use a pool after calling end on the pool");
            return Reflect.apply(value, state.db, args);
          };
        },
      });
    }
    async $disconnect() { this.ended = true; }
  },
}));

let createDedicatedStorageFile: typeof import("@/lib/storage").createDedicatedStorageFile;

beforeAll(async () => {
  const fromWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
  vi.doMock(fromWeb.resolve("next/server"), () => ({
    after: (callback: () => unknown) => { state.afterCallbacks.push(callback); },
  }));
  vi.doMock(fromWeb.resolve("@opennextjs/cloudflare"), () => ({
    getCloudflareContext: state.getContext,
  }));
  vi.doMock(fromWeb.resolve("@prisma/adapter-pg"), () => ({ PrismaPg: class {} }));
  // Register the real Web factory and exercise the real storage adapter.
  await import("../../apps/web/src/prisma");
  ({ createDedicatedStorageFile } = await import("@/lib/storage"));
});

describe("storage cleanup after the Web response closes", () => {
  let memory: ReturnType<typeof createInMemoryPrisma>;
  let background: Promise<unknown>[];
  let bucket: { put: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T00:00:00.000Z"));
    memory = createInMemoryPrisma();
    state.db = memory.prisma as unknown as Record<string, unknown>;
    state.clients.length = 0;
    state.afterCallbacks.length = 0;
    background = [];
    bucket = { put: vi.fn() };
    state.getContext.mockReturnValue({
      env: {
        BEUTL_DATABASE_HYPERDRIVE: { connectionString: "postgres://storage-background-test" },
        BEUTL_R2_BUCKET: bucket,
      },
      ctx: { waitUntil: (task: Promise<unknown>) => background.push(task) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([true, false])("persists late cleanup on its own client after a put settles (success: %s)", async (success) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let settlePut!: () => void;
    bucket.put.mockImplementation(() => new Promise<void>((resolve, reject) => {
      settlePut = () => success ? resolve() : reject(new Error("late provider failure"));
    }));
    const operation = runWithSharedDb(() => createDedicatedStorageFile({
      file: new File([new Uint8Array([1])], "late.png", { type: "image/png" }),
      userId: "owner",
      quota: { quotaBytes: 10n, fileCountLimit: 10 },
    }));
    const rejection = operation.catch((error: unknown) => error);
    await vi.waitFor(() => expect(bucket.put).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(rejection).resolves.toMatchObject({
      message: expect.stringContaining("exceeded its local deadline"),
    });
    const upload = [...memory.state.storageUploads.values()][0];
    expect(upload.completionState).toBe("unknown");
    expect(state.clients).toHaveLength(1);

    // Finish the response before the R2 put settles, the ordering missed by
    // the original action-scope test. The request's pool is now unusable.
    await Promise.all(state.afterCallbacks.splice(0).map((callback) => callback()));
    expect(state.clients[0].ended).toBe(true);
    settlePut();
    await Promise.all(background);

    expect(memory.state.storageUploads.get(upload.id)).toMatchObject({
      abandonedAt: expect.any(Date),
      creationLeaseToken: null,
      creationLeaseUntil: null,
    });
    expect(memory.state.aiStorageCleanups.get(upload.objectKey)).toMatchObject({
      state: "cleanup",
      notBefore: new Date(),
    });
    expect(state.clients).toHaveLength(2);
    expect(state.clients[1].ended).toBe(true);
    expect(state.afterCallbacks).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
  });
});
