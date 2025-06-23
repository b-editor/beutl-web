import "server-only";
import { Hono } from "hono";
import { drizzle } from "@/drizzle";
import { apiErrorResponse } from "@/lib/api/error";
import { getUserId } from "@/lib/api/auth";
import { guessCurrency } from "@/lib/currency";
import { getPackages, mapPackage } from "@/lib/api/packages-db";
import { getUserProfile } from "./user";
import { profile } from "@/drizzle/schema";
import { ilike } from "drizzle-orm";

const app = new Hono()
  .get("/:name", async (c) => {
    const name = c.req.param("name");
    const profile = await getUserProfile({
      userName: name
    });

    if (!profile) {
      return c.json(await apiErrorResponse("userNotFound"), { status: 404 });
    }

    return c.json(profile);
  })
  .get("/:name/packages", async (c) => {
    const name = c.req.param("name");
    const currentUserId = await getUserId(c);
    const currency = await guessCurrency();
    const db = await drizzle();
    const userId = await db.select({ userId: profile.userId }).from(profile)
      .where(ilike(profile.userName, name))
      .limit(1)
      .then((rows) => rows.at(0)?.userId);
    if (!userId) {
      return c.json(await apiErrorResponse("userNotFound"), { status: 404 });
    }
    const packages = await getPackages({
      ownerId: userId,
      published: true,
      userId: currentUserId ?? undefined,
      currency,
    });

    return c.json(
      await Promise.all(
        packages.map(
          async (pkg) =>
            await mapPackage({
              userId: currentUserId ?? undefined,
              currency,
              pkg,
            }),
        ),
      ),
    );
  });

export default app;
