import { Hono } from "hono";
import { apiErrorResponse } from "../api/error";
import { getUserId } from "../api/auth";
import { guessCurrency } from "../currency";
import { getPackages, mapPackage } from "../api/packages-db";
import { findUserIdByUserName } from "@beutl/db";
import { getUserProfile } from "./user";

const app = new Hono()
  .get("/:name", async (c) => {
    const name = c.req.param("name");
    const profile = await getUserProfile({
      userName: {
        equals: name,
        mode: "insensitive",
      },
    }, c.req.raw);

    if (!profile) {
      return c.json(await apiErrorResponse("userNotFound"), { status: 404 });
    }

    return c.json(profile);
  })
  .get("/:name/packages", async (c) => {
    const name = c.req.param("name");
    const currentUserId = await getUserId(c);
    const currency = await guessCurrency(c.req.raw);
    const userId = (
      await findUserIdByUserName({
        name,
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
              request: c.req.raw,
            }),
        ),
      ),
    );
  });

export default app;
