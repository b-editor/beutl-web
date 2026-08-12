import { describe, expect, it, vi } from "vitest";
import { publishReleaseArtifactReplacement } from "@/lib/release-artifact-publication";

describe("release artifact publication", () => {
  it("keeps the authoritative upload and drains old cleanup after success", async () => {
    const replace = vi.fn(async () => ({ id: "release-id" }));
    const abandon = vi.fn(async () => undefined);
    const drain = vi.fn(async () => undefined);

    await expect(
      publishReleaseArtifactReplacement({ replace, abandon, drain }),
    ).resolves.toEqual({ id: "release-id" });
    expect(abandon).not.toHaveBeenCalled();
    expect(drain).toHaveBeenCalledOnce();
  });

  it("marks the losing upload for cleanup without masking the CAS conflict", async () => {
    const conflict = new Error("release conflict");
    const abandon = vi.fn(async () => {
      throw new Error("cleanup database temporarily unavailable");
    });

    await expect(
      publishReleaseArtifactReplacement({
        replace: async () => { throw conflict; },
        abandon,
        drain: async () => undefined,
      }),
    ).rejects.toBe(conflict);
    expect(abandon).toHaveBeenCalledOnce();
  });

  it("does not break a successful response when cleanup retries or double deletes", async () => {
    await expect(
      publishReleaseArtifactReplacement({
        replace: async () => "authoritative",
        abandon: async () => undefined,
        drain: async () => {
          throw new Error("already deleted");
        },
      }),
    ).resolves.toBe("authoritative");
  });

  it("allows only one parallel swap and recovers the old and losing artifacts", async () => {
    let authoritative = "old-object";
    const queued = new Set<string>();
    const deleted = new Set<string>();

    const swap = async (expected: string, replacement: string) =>
      await publishReleaseArtifactReplacement({
        replace: async () => {
          await Promise.resolve();
          if (authoritative !== expected) throw new Error("release conflict");
          authoritative = replacement;
          queued.add(expected);
          return replacement;
        },
        abandon: async () => {
          queued.add(replacement);
        },
        drain: async () => {
          for (const object of queued) {
            if (object !== authoritative) deleted.add(object);
          }
        },
      });

    const results = await Promise.allSettled([
      swap("old-object", "first-object"),
      swap("old-object", "second-object"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(["first-object", "second-object"]).toContain(authoritative);
    expect(deleted).toContain("old-object");
    expect(deleted).toContain(
      authoritative === "first-object" ? "second-object" : "first-object",
    );
    expect(deleted).not.toContain(authoritative);
  });
});
