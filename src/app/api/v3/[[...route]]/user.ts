import "server-only";
import { Hono } from "hono";
import { drizzle } from "@/drizzle";
import { apiErrorResponse } from "@/lib/api/error";
import { getUserId } from "@/lib/api/auth";
import { getContentUrl } from "@/lib/db/file";
import { profile } from "@/drizzle/schema";
import { eq, ilike } from "drizzle-orm";

export async function getUserProfile({ userName, userId }: {
  userName?: string,
  userId?: string;
}) {
  if (!userName && !userId) throw new Error("Either userName or userId must be provided");
  const db = await drizzle();
  const row = await db.select({
    userId: profile.userId,
    displayName: profile.displayName,
    iconFileId: profile.iconFileId,
    userName: profile.userName,
    bio: profile.bio,
  }).from(profile)
    .where(userName ? ilike(profile.userName, userName) : eq(profile.userId, userId!))
    .limit(1)
    .then(rows => rows.at(0));

  if (!row) {
    return null;
  }
  return {
    id: row.userId,
    name: row.userName,
    displayName: row.displayName,
    bio: row.bio,
    iconId: row.iconFileId,
    iconUrl: await getContentUrl(row.iconFileId),
  };
}

const app = new Hono().get("/", async (c) => {
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
