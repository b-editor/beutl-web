import "server-only";
import { Hono } from "hono";
import { getDbAsync } from "@/db";
import { profile } from "@/db/schema";
import { eq, type SQL } from "drizzle-orm";
import { apiErrorResponse } from "@/lib/api/error";
import { getUserId } from "@/lib/api/auth";
import { getContentUrl } from "@/lib/db/file";

export async function getUserProfile(where: SQL) {
  const db = await getDbAsync();
  const profileResult = await db.query.profile.findFirst({
    where,
    columns: {
      userId: true,
      displayName: true,
      iconFileId: true,
      userName: true,
      bio: true,
    },
  });
  if (!profileResult) {
    return null;
  }
  return {
    id: profileResult.userId,
    name: profileResult.userName,
    displayName: profileResult.displayName || profileResult.userName,
    bio: profileResult.bio,
    iconId: profileResult.iconFileId,
    iconUrl: await getContentUrl(profileResult.iconFileId),
  };
}

const app = new Hono().get("/", async (c) => {
  const currentUserId = await getUserId(c);
  if (!currentUserId) {
    return c.json(await apiErrorResponse("authenticationIsRequired"), {
      status: 401,
    });
  }
  const userProfile = await getUserProfile(
    eq(profile.userId, currentUserId),
  );
  if (!userProfile) {
    return c.json(await apiErrorResponse("userNotFound"), { status: 404 });
  }
  return c.json(userProfile);
});

export default app;
