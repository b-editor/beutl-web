import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  existsUserPaymentHistory: vi.fn(),
  findProfileForDiscover: vi.fn(),
}));
const authMocks = vi.hoisted(() => ({
  getUserId: vi.fn(),
}));

vi.mock("@beutl/db", () => dbMocks);
vi.mock("../../packages/api/src/api/auth", () => authMocks);

import {
  applyPackageType,
  getPackageType,
  isPackageTypeFilter,
  packageTypeWhere,
  visiblePackageTags,
} from "@beutl/core";
import discover from "../../packages/api/src/v3/discover";
import { retrievePackages } from "../../packages/api/src/store-utils";

const findMany = vi.fn();

function whereOf(call: number) {
  return findMany.mock.calls[call][0].where;
}

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  dbMocks.getDb.mockResolvedValue({
    package: { findMany },
    userPackage: { findFirst: vi.fn().mockResolvedValue(null) },
  });
  dbMocks.existsUserPaymentHistory.mockResolvedValue(false);
  dbMocks.findProfileForDiscover.mockResolvedValue(null);
  authMocks.getUserId.mockResolvedValue(null);
});

describe("package type derived from reserved tags", () => {
  it("treats a package with neither reserved tag as an extension", () => {
    expect(getPackageType([])).toBe("extension");
    expect(getPackageType(["blur", "effect"])).toBe("extension");
    expect(getPackageType(null)).toBe("extension");
  });

  it("reads the kind off the reserved tag wherever it sits", () => {
    expect(getPackageType(["fonts", "material"])).toBe("material");
    expect(getPackageType(["template", "titles"])).toBe("template");
  });

  it("resolves a package carrying both reserved tags to material", () => {
    expect(getPackageType(["template", "material"])).toBe("material");
  });

  it("hides the reserved tags from the author's own tag list", () => {
    expect(visiblePackageTags(["material", "fonts", "cc0"])).toEqual([
      "fonts",
      "cc0",
    ]);
    expect(visiblePackageTags(undefined)).toEqual([]);
  });

  it("replaces the kind marker rather than stacking markers", () => {
    expect(applyPackageType(["material", "fonts"], "template")).toEqual([
      "template",
      "fonts",
    ]);
    expect(applyPackageType(["template", "fonts"], "extension")).toEqual([
      "fonts",
    ]);
    expect(applyPackageType(["fonts"], "material")).toEqual([
      "material",
      "fonts",
    ]);
  });

  it("accepts only the four filter values", () => {
    expect(isPackageTypeFilter("all")).toBe(true);
    expect(isPackageTypeFilter("material")).toBe(true);
    expect(isPackageTypeFilter("plugin")).toBe(false);
    expect(isPackageTypeFilter(undefined)).toBe(false);
  });

  it("selects extensions by absence of every reserved tag", () => {
    // Prisma has no `hasNone`; the negated `hasSome` is the documented stand-in.
    expect(packageTypeWhere("extension")).toEqual({
      NOT: { tags: { hasSome: ["material", "template"] } },
    });
    expect(packageTypeWhere("material")).toEqual({ tags: { has: "material" } });
    expect(packageTypeWhere("all")).toEqual({});
    expect(packageTypeWhere(undefined)).toEqual({});
  });
});

describe("retrievePackages type filtering", () => {
  it("does not constrain tags when no type is given", async () => {
    await retrievePackages(undefined, undefined);

    expect(whereOf(0)).toEqual({ published: true });
  });

  it("does not constrain tags for the all filter", async () => {
    await retrievePackages(undefined, undefined, "all");

    expect(whereOf(0)).toEqual({ published: true });
  });

  it("requires the reserved tag for a data package filter", async () => {
    await retrievePackages(undefined, undefined, "template");

    expect(whereOf(0)).toEqual({
      published: true,
      tags: { has: "template" },
    });
  });

  it("excludes every reserved tag for the extension filter", async () => {
    await retrievePackages(undefined, undefined, "extension");

    expect(whereOf(0)).toEqual({
      published: true,
      NOT: { tags: { hasSome: ["material", "template"] } },
    });
  });

  it("intersects the type filter with the text search instead of widening it", async () => {
    await retrievePackages("noise", undefined, "material");

    const where = whereOf(0);
    expect(where.tags).toEqual({ has: "material" });
    expect(where.OR).toHaveLength(5);
  });
});

describe("v3 discover type query parameter", () => {
  it("passes the requested type through to /search", async () => {
    const res = await discover.request("/search?query=noise&type=material");

    expect(res.status).toBe(200);
    expect(whereOf(0).tags).toEqual({ has: "material" });
  });

  it("passes the requested type through to /featured", async () => {
    const res = await discover.request("/featured?type=template");

    expect(res.status).toBe(200);
    expect(whereOf(0).tags).toEqual({ has: "template" });
  });

  it("keeps listing every kind when the client omits type", async () => {
    // Desktop clients released before data packages never send the parameter.
    const searched = await discover.request("/search?query=noise");
    const featured = await discover.request("/featured");

    expect(searched.status).toBe(200);
    expect(featured.status).toBe(200);
    expect(whereOf(0).tags).toBeUndefined();
    expect(whereOf(0).NOT).toBeUndefined();
    expect(whereOf(1).tags).toBeUndefined();
    expect(whereOf(1).NOT).toBeUndefined();
  });

  it("rejects an unknown type instead of silently listing everything", async () => {
    const res = await discover.request("/search?type=plugin");

    expect(res.status).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });
});
