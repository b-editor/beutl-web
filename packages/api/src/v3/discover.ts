import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  type ListedPackage,
  packageOwned,
  packagePaied,
  retrievePackages,
} from "../store-utils";
import { getUserId } from "../api/auth";
import { getContentUrl } from "../content-url";
import { findProfileForDiscover } from "@beutl/db";

const searchQuerySchema = z.object({
  query: z.string().optional(),
  offset: z.coerce.number().min(0).optional().default(0),
  count: z.coerce.number().min(1).max(100).optional().default(30),
});

async function mapPackage(pkg: ListedPackage, userId: string | null, request?: Request) {
  const profile = await findProfileForDiscover({
    userId: pkg.userId,
  });
  let paid = false;
  let owned = false;
  if (userId != null) {
    paid = await packagePaied(pkg.id, userId);
    owned = await packageOwned(pkg.id, userId);
  }

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
    paid: paid,
    owned: owned,
    owner: {
      id: pkg.userId,
      name: profile?.userName || "",
      displayName: profile?.displayName || "",
      bio: profile?.bio,
      iconId: profile?.iconFileId,
      iconUrl: await getContentUrl(profile?.iconFileId, request),
    },
  };
}

const app = new Hono()
  .get("/search", zValidator("query", searchQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const userId = await getUserId(c);

    const packages = await retrievePackages(query.query, c.req.raw);
    const result = await Promise.all(
      packages.map(async (pkg) => await mapPackage(pkg, userId, c.req.raw)),
    );

    return c.json(result);
  })
  .get("/featured", async (c) => {
    const userId = await getUserId(c);

    const packages = await retrievePackages(undefined, c.req.raw);
    const result = await Promise.all(
      packages.map(async (pkg) => await mapPackage(pkg, userId, c.req.raw)),
    );

    return c.json(result);
  });

export default app;
