import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";

vi.mock("@/lib/auth-guard", () => ({ authenticated: async (fn: (session: unknown) => unknown) => fn({ user: { id: "owner", name: "Owner" } }) }));
vi.mock("@beutl/next/language", () => ({ getLanguage: async () => "en" }));
vi.mock("@beutl/next/audit-log", () => ({ addAuditLog: async () => {}, auditLogActions: { developer: {} } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/storage", () => ({ createDedicatedStorageFile: vi.fn() }));
import { updateRelease } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/developer/projects/[name]/actions/release";

const RELEASE_ID = "c7bc502e-aee6-4fbf-87f9-0c413659b1fe";
describe("editing a release without replacing its artifact", () => {
  let row: {
    id: string; packageId: string; version: string; published: boolean;
    file: { id: string; userId: string } | null;
  };
  let update: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    row = { id: RELEASE_ID, packageId: "pkg", version: "2.0.0", published: false, file: { id: "existing-file", userId: "owner" } };
    update = vi.fn(async ({ data }) => Object.assign(row, data));
    const models = {
      release: {
        findFirst: async () => ({ ...row }),
        findFirstOrThrow: async () => ({ ...row }),
        update,
      },
      package: { findFirst: async () => ({ id: "pkg", name: "Package", userId: "owner", tags: [] }) },
    };
    setDbProvider(async () => ({
      ...models,
      $transaction: async (fn: (tx: typeof models) => unknown) => fn(models),
    }) as never);
  });
  function input(published: boolean) {
    const form = new FormData();
    form.set("id", RELEASE_ID);
    form.set("title", "Updated title");
    form.set("description", "Updated description");
    form.set("targetVersion", "2.0.0");
    form.set("published", published ? "on" : "off");
    return form;
  }
  it.each([true, false])("saves metadata and publication=%s while retaining the current file", async (published) => {
    const result = await updateRelease(input(published));
    expect(result.success).toBe(true);
    expect(row).toMatchObject({ title: "Updated title", published, fileId: "existing-file" });
  });
  it("allows editing a draft before uploading its first file", async () => {
    row.file = null;
    expect((await updateRelease(input(false))).success).toBe(true);
  });
  it("does not publish an artifact-free draft when the file field becomes optional", async () => {
    row.file = null;
    expect((await updateRelease(input(true))).success).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(row.published).toBe(false);
  });
});
