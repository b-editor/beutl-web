import "server-only";
import { Hono } from "hono";
import { prisma } from "@/prisma";
import { apiErrorResponse } from "@/lib/api/error";
import { getUserId } from "@/lib/api/auth";
import { guessCurrency } from "@/lib/currency";
import { getPackages, mapPackage } from "@/lib/api/packages-db";
import { getUserProfile } from "./user";

const app = new Hono()
  .get("/:name", async (c) => {
    const name = c.req.param("name");
    const profile = await getUserProfile({
      userName: {
        equals: name,
        mode: "insensitive",
      },
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
    const db = await prisma();
    const userId = (
      await db.profile.findFirst({
        where: {
          userName: {
            equals: name,
            mode: "insensitive",
          },
        },
        select: {
          userId: true,
        },
      })
    )?.userId;
    if (!userId) {
      return c.json(await apiErrorResponse("userNotFound"), { status: 404 });
    }
    const packages = await getPackages({
      query: {
        userId: userId,
        published: true,
      },
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
