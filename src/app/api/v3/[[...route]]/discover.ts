import "server-only";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "@/prisma";
import {
  type ListedPackage,
  packageOwned,
  packagePaied,
  retrievePackages,
} from "@/lib/store-utils";
import { getUserId } from "./auth";

const searchQuerySchema = z.object({
  query: z.string().optional(),
  offset: z.coerce.number().min(0).optional().default(0),
  count: z.coerce.number().min(1).max(100).optional().default(30),
});

async function mapPackage(pkg: ListedPackage, userId: string | null) {
  const profile = await prisma.profile.findFirst({
    where: {
      userId: pkg.userId,
    },
    select: {
      userName: true,
      displayName: true,
      bio: true,
      iconFileId: true,
    },
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
    logoId: pkg.iconFileId,
    logoUrl: pkg.iconFileId
      ? `https://beutl.beditor.net/api/contents/${pkg.iconFileId}`
      : undefined,
    currency: pkg.price?.currency,
    price: pkg.price?.price,
    paid: paid,
    owned: owned,
    owner: {
      id: pkg.userId,
      name: profile?.userName || "",
      displayName: profile?.displayName || "",
      bio: profile?.bio,
      iconId: profile?.iconFileId,
      iconUrl: profile?.iconFileId
        ? `https://beutl.beditor.net/api/contents/${profile.iconFileId}`
        : undefined,
    },
  };
}

const app = new Hono()
  .get("/search", zValidator("query", searchQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const userId = await getUserId(c);

    const packages = await retrievePackages(query.query);
    const result = await Promise.all(
      packages.map(async (pkg) => await mapPackage(pkg, userId)),
    );

    return c.json(result);
  })
  .get("/featured", async (c) => {
    const userId = await getUserId(c);

    const packages = await retrievePackages();
    const result = await Promise.all(
      packages.map(async (pkg) => await mapPackage(pkg, userId)),
    );

    return c.json(result);
  });

export default app;
