import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  type ListedPackage,
  ownedPackageIds,
  paidPackageIds,
  retrievePackages,
} from "../store-utils";
import { getUserId } from "../api/auth";
import { getContentUrl } from "../content-url";
import { PACKAGE_TYPE_FILTERS } from "@beutl/core";
import { getLanguage } from "../lang-utils";

// Omitting `type` keeps the pre-data-package behaviour: every kind is listed.
const packageTypeSchema = z.enum(PACKAGE_TYPE_FILTERS).optional().default("all");
// Offset pagination traverses discarded rows too, so count alone cannot bound it.
const MAX_SEARCH_OFFSET = 10_000;

// 表示言語の上書き。省略時は Accept-Language から解決する (どちらも原文
// フォールバックがあるので、未知の言語が来ても壊れない)。
const langSchema = z.string().optional();

const searchQuerySchema = z.object({
  query: z.string().optional(),
  type: packageTypeSchema,
  lang: langSchema,
  offset: z.string().trim().min(1)
    .pipe(z.coerce.number<string>().int().min(0).max(MAX_SEARCH_OFFSET))
    .optional().default(0),
  count: z.coerce.number().int().min(1).max(100).optional().default(30),
});

const featuredQuerySchema = z.object({
  type: packageTypeSchema,
  lang: langSchema,
});

async function mapPackages(packages: ListedPackage[], userId: string | null, request?: Request) {
  const ids = packages.map((pkg) => pkg.id);
  const [paid, owned] = await Promise.all([
    paidPackageIds(ids, userId),
    ownedPackageIds(ids, userId),
  ]);

  return await Promise.all(packages.map(async (pkg) => {
    const profile = pkg.profile;
    return {
      id: pkg.id,
      name: pkg.name,
      displayName: pkg.displayName,
      shortDescription: pkg.shortDescription,
      tags: pkg.tags,
      logoId: pkg.iconFileId || null,
      logoUrl: await getContentUrl(pkg.iconFileId, request),
      currency: pkg.price?.currency || null,
      price: pkg.price?.price || null,
      paid: paid.has(pkg.id),
      owned: owned.has(pkg.id),
      owner: {
        id: pkg.userId,
        name: profile?.userName || "",
        displayName: profile?.displayName || "",
        bio: profile?.bio,
        iconId: profile?.iconFileId,
        iconUrl: await getContentUrl(profile?.iconFileId, request),
      },
    };
  }));
}

const app = new Hono()
  .get("/search", zValidator("query", searchQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const userId = await getUserId(c);
    const lang = query.lang ?? await getLanguage(c.req.raw);

    const packages = await retrievePackages(query.query, c.req.raw, query.type, {
      offset: query.offset,
      count: query.count,
    }, lang);

    return c.json(await mapPackages(packages, userId, c.req.raw));
  })
  .get("/featured", zValidator("query", featuredQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const userId = await getUserId(c);
    const lang = query.lang ?? await getLanguage(c.req.raw);

    const packages = await retrievePackages(undefined, c.req.raw, query.type, undefined, lang);

    return c.json(await mapPackages(packages, userId, c.req.raw));
  });

export default app;
