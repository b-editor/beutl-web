import "server-only";
import { Hono } from "hono";
import { getDbAsync } from "@/db";
import { profile, packageTable } from "@/db/schema";
import { and, eq, ilike } from "drizzle-orm";
import { apiErrorResponse } from "@/lib/api/error";
import { getUserId } from "@/lib/api/auth";
import { guessCurrency } from "@/lib/currency";
import { getPackages, mapPackage } from "@/lib/api/packages-db";
import { getUserProfile } from "./user";

const app = new Hono()
  .get("/:name", async (c) => {
    const name = c.req.param("name");
    const profileResult = await getUserProfile(
      ilike(profile.userName, name),
    );

    if (!profileResult) {
      return c.json(await apiErrorResponse("userNotFound"), { status: 404 });
    }

    return c.json(profileResult);
  })
  .get("/:name/packages", async (c) => {
    const name = c.req.param("name");
    const currentUserId = await getUserId(c);
    const currency = await guessCurrency();
    const db = await getDbAsync();
    const profileResult = await db.query.profile.findFirst({
      where: ilike(profile.userName, name),
      columns: {
        userId: true,
      },
    });
    const userId = profileResult?.userId;
    if (!userId) {
      return c.json(await apiErrorResponse("userNotFound"), { status: 404 });
    }
    const packages = await getPackages({
      where: and(eq(packageTable.userId, userId), eq(packageTable.published, true))!,
      userId: currentUserId ?? undefined,
      currency: currency ?? undefined,
    });

    return c.json(
      await Promise.all(
        packages.map(
          async (pkg) =>
            await mapPackage({
              userId: currentUserId ?? undefined,
              currency: currency ?? undefined,
              pkg,
            }),
        ),
      ),
    );
  });

export default app;
