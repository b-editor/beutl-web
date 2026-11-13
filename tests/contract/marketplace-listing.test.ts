import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDbProvider } from "@beutl/db";
vi.mock("../../packages/api/src/api/auth", () => ({ getUserId: async () => "reader" }));
vi.mock("../../packages/api/src/currency", () => ({ guessCurrency: async () => "USD" }));
import discover from "../../packages/api/src/v3/discover";
import library from "../../packages/api/src/v3/library";

function pkg(id: string, published = true) {
  return {
    id, name: id, displayName: null, shortDescription: "", tags: [], published,
    iconFileId: null, userId: "publisher", user: { Profile: null as { userName: string } | null },
    packagePricing: [], Release: [] as { id: string; version: string }[],
  };
}
type Package = ReturnType<typeof pkg>;
type Query = { where?: { id?: { in: string[] }; packageId?: { in: string[] } }; skip?: number; take?: number };
const inIds = (ids: { in: string[] } | undefined, id: string) => !ids || ids.in.includes(id);

describe("marketplace list contracts", () => {
  let packages: Package[];
  let releases: { id: string; version: string; title: string; description: string; targetVersion: null; fileId: null }[];
  let findMany: ReturnType<typeof vi.fn>;
  let paidFindMany: ReturnType<typeof vi.fn>;
  let ownedFindMany: ReturnType<typeof vi.fn>;
  let releaseFindMany: ReturnType<typeof vi.fn>;
  let profileFindFirst: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    packages = [pkg("p3"), pkg("p2"), pkg("p1")];
    releases = [];
    findMany = vi.fn(async (query: Query) => packages.filter((row) => inIds(query.where?.id, row.id))
      .slice(query.skip ?? 0, query.take === undefined ? undefined : (query.skip ?? 0) + query.take));
    paidFindMany = vi.fn(async () => []);
    ownedFindMany = vi.fn(async ({ where }: Query) => ["p3", "hidden", "gone", "p1"]
      .filter((id) => inIds(where?.packageId, id)).map((packageId) => ({ packageId })));
    releaseFindMany = vi.fn(async ({ where }: Query) => releases.filter((row) => inIds(where?.id, row.id)));
    profileFindFirst = vi.fn(async () => null);
    setDbProvider(async () => ({
      package: { findMany },
      profile: { findFirst: profileFindFirst },
      release: { findMany: releaseFindMany },
      userPaymentHistory: { findMany: paidFindMany },
      userPackage: { findMany: ownedFindMany },
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
  it.each(["count=1.5", "offset=0.5", "count=101", "offset=-1", "offset=2147483648", "offset=", "offset=%20", "offset=%09", "offset=10001"])(
    "rejects invalid pagination without a database query: %s", async (query) => {
      expect((await discover.request(`/search?${query}`)).status).toBe(400);
      expect(findMany).not.toHaveBeenCalled();
    },
  );
  it.each(["offset=0", "offset=%202%20", "offset=10000"])("accepts nonempty offsets within the supported depth: %s", async (query) => {
    expect((await discover.request(`/search?${query}`)).status).toBe(200);
    expect(findMany).toHaveBeenCalledOnce();
  });
  it.each(["/search", "/featured"])("bounds the default listing: %s", async (path) => {
    await discover.request(path);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 30, skip: 0 }));
  });
  it("reads the owners with the page and the paid and owned flags in one query each", async () => {
    packages[1].user.Profile = { userName: "maker" };
    paidFindMany.mockResolvedValue([{ packageId: "p2" }]);
    const body = await (await discover.request("/featured")).json();
    expect(body.map((row: { id: string; paid: boolean; owned: boolean; owner: { name: string } }) =>
      [row.id, row.paid, row.owned, row.owner.name])).toEqual([
      ["p3", false, true, ""], ["p2", true, false, "maker"], ["p1", false, true, ""],
    ]);
    expect(paidFindMany).toHaveBeenCalledOnce();
    expect(ownedFindMany).toHaveBeenCalledOnce();
    expect(profileFindFirst).not.toHaveBeenCalled();
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
  it("loads the library and the latest releases of its packages in one query each", async () => {
    packages[0].Release = [{ id: "r9", version: "1.9.0" }, { id: "r10", version: "1.10.0" }];
    packages[2].Release = [{ id: "r1", version: "1.0.0" }];
    releases = ["r10", "r1"].map((id) => ({ id, version: id, title: "", description: "", targetVersion: null, fileId: null }));
    const body = await (await library.request("/")).json();
    expect(body.map((row: { package: Package; latestRelease: { id: string } | null }) =>
      [row.package.id, row.latestRelease?.id])).toEqual([["p3", "r10"], ["p1", "r1"]]);
    expect(findMany).toHaveBeenCalledOnce();
    expect(releaseFindMany).toHaveBeenCalledOnce();
    expect(releaseFindMany.mock.calls[0][0].where.id).toEqual({ in: ["r10", "r1"] });
  });
});
