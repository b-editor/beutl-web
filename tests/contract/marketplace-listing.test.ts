import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
vi.mock("../../packages/api/src/api/auth", () => ({ getUserId: async () => "reader" }));
vi.mock("../../packages/api/src/currency", () => ({ guessCurrency: async () => "USD" }));
import discover from "../../packages/api/src/v3/discover";
import library from "../../packages/api/src/v3/library";

function pkg(id: string, published = true) {
  return {
    id, name: id, displayName: null, shortDescription: "", tags: [], published,
    iconFileId: null, userId: "publisher", user: { Profile: null }, packagePricing: [], Release: [],
  };
}
type Package = ReturnType<typeof pkg>;

describe("marketplace list contracts", () => {
  let packages: Package[];
  let findMany: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    packages = [pkg("p3"), pkg("p2"), pkg("p1")];
    findMany = vi.fn(async (query) => packages.slice(query.skip ?? 0,
      query.take === undefined ? undefined : (query.skip ?? 0) + query.take));
    setDbProvider(async () => ({
      package: {
        findMany,
        findFirst: async ({ where }: { where: { id: string } }) => packages.find((row) => row.id === where.id) ?? null,
      },
      profile: { findFirst: async () => null },
      userPaymentHistory: { findFirst: async () => null },
      userPackage: {
        findFirst: async () => null,
        findMany: async () => [{ packageId: "p3" }, { packageId: "hidden" }, { packageId: "gone" }, { packageId: "p1" }],
      },
    }) as never);
  });
  it("applies count and offset before mapping search results", async () => {
    const response = await discover.request("/search?count=1&offset=1");
    expect(response.status).toBe(200);
    expect((await response.json()).map((row: Package) => row.id)).toEqual(["p2"]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 1, skip: 1, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }));
  });
  it("returns an empty page past the end instead of repeating the whole catalog", async () => {
    expect(await (await discover.request("/search?count=1&offset=3")).json()).toEqual([]);
  });
  it.each(["count=1.5", "offset=0.5", "count=101", "offset=-1", "offset=2147483648"])(
    "rejects invalid pagination without a database query: %s", async (query) => {
      expect((await discover.request(`/search?${query}`)).status).toBe(400);
      expect(findMany).not.toHaveBeenCalled();
    },
  );
  it.each(["/search", "/featured"])("bounds the default listing: %s", async (path) => {
    await discover.request(path);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 30, skip: 0 }));
  });
  it("omits unpublished and missing packages while retaining visible library entries", async () => {
    packages.push(pkg("hidden", false));
    const response = await library.request("/");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.map((row: { package: Package }) => row.package.id)).toEqual(["p3", "p1"]);
    expect(body).not.toContain(null);
  });
  it("returns an empty array when all acquired packages are hidden or missing", async () => {
    packages = packages.map((row) => ({ ...row, published: false }));
    expect(await (await library.request("/")).json()).toEqual([]);
  });
});
