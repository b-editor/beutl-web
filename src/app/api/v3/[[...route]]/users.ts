import "server-only";
import { Hono } from "hono";
import { prisma } from "@/prisma";
import { apiErrorResponse } from "@/lib/api/error";
import type { Prisma } from "@prisma/client";
import { getUserId } from "@/lib/api/auth";
import { guessCurrency } from "@/lib/currency";
import { getPackages, mapPackage } from "@/lib/api/packages-db";

async function getUserProfile(query: Prisma.ProfileWhereInput) {
  const profile = await prisma.profile.findFirst({
    where: query,
    select: {
      userId: true,
      displayName: true,
      iconFileId: true,
      userName: true,
      bio: true,
    },
  });
  if (!profile) {
    return null;
  }
  return {
    id: profile.userId,
    name: profile.userName,
    displayName: profile.displayName,
    bio: profile.bio,
    iconId: profile.iconFileId,
    iconUrl: profile.iconFileId
      ? `https://beutl.beditor.net/api/contents/${profile.iconFileId}`
      : null,
  };
}

const app = new Hono()
  .get("/:name", async (c) => {
    const name = c.req.param("name");
    const profile = await getUserProfile({
      userId: {
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
    const userId = (
      await prisma.profile.findFirst({
        where: {
          userId: {
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
  })
  .get("/", async (c) => {
    const currentUserId = await getUserId(c);
    if (!currentUserId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }
    const profile = await getUserProfile({
      userId: currentUserId,
    });
    if (!profile) {
      return c.json(await apiErrorResponse("userNotFound"), { status: 404 });
    }
    return c.json(profile);
  });

export default app;
