import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, runWithDbProvider, setDbProvider } from "@beutl/db";
import { authenticated } from "@/lib/auth-guard";
import { updateTag } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/package";

vi.mock("@/lib/better-auth", () => ({
  auth: {
    api: {
      getSession: async () => {
        // Better Auth acquires its Prisma adapter before reading a session.
        const { getDb } = await import("@beutl/db");
        await getDb();
        return { user: { id: "owner" }, session: { id: "session" } };
      },
    },
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@beutl/next/language", () => ({ getLanguage: async () => "en" }));

function provider() {
  return vi.fn(async () => ({
    package: {
      findFirst: async () => ({ userId: "owner" }),
      update: async () => ({ name: "Beutl.Extensions.Karaoke" }),
    },
    auditLog: { create: async () => ({}) },
  }) as never);
}

describe("Server Action database clients outside a React render", () => {
  let createClient: ReturnType<typeof provider>;

  beforeEach(() => {
    createClient = provider();
    setDbProvider(createClient);
  });

  it("shares one client between tag authentication, ownership, update and audit", async () => {
    expect(await updateTag({ packageId: "package", tags: ["lyrics"] }))
      .toMatchObject({ success: true });
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent client acquisition inside an action", async () => {
    const clients = await authenticated(async () =>
      Promise.all([getDb(), getDb(), getDb()]),
    );
    expect(Array.isArray(clients)).toBe(true);
    expect(new Set(clients as unknown[]).size).toBe(1);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("creates a fresh client for each repeated tag save", async () => {
    for (const tags of [["lyrics"], ["lyrics", "lrc"], ["lyrics", "lrc", "karaoke"]]) {
      expect(await updateTag({ packageId: "package", tags }))
        .toMatchObject({ success: true });
    }
    expect(createClient).toHaveBeenCalledTimes(3);
    const clients = await Promise.all(createClient.mock.results.map(({ value }) => value));
    expect(new Set(clients).size).toBe(3);
  });

  it("keeps overlapping actions on their own invocation's provider", async () => {
    const otherProvider = provider();
    const [first, second] = await Promise.all([
      runWithDbProvider(createClient, () => authenticated(async () => getDb())),
      runWithDbProvider(otherProvider, () => authenticated(async () => getDb())),
    ]);
    expect(first).not.toBe(second);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(otherProvider).toHaveBeenCalledTimes(1);
  });

  it("restores the outer provider when an action throws", async () => {
    await expect(authenticated(async () => {
      await getDb();
      throw new Error("save failed");
    })).rejects.toThrow("save failed");
    expect(createClient).toHaveBeenCalledTimes(1);
    await getDb();
    expect(createClient).toHaveBeenCalledTimes(2);
  });
});
