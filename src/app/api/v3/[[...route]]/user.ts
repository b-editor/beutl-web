import "server-only";
import { Hono } from "hono";
import { apiErrorResponse } from "@/lib/api/error";
import type { Prisma } from "@prisma/client";
import { getUserId } from "@/lib/api/auth";
import { getContentUrl } from "@/lib/content-url";
import { findProfileForApi } from "@/lib/db/profile";

export async function getUserProfile(query: Prisma.ProfileWhereInput) {
  const profile = await findProfileForApi({ where: query });
  if (!profile) {
    return null;
  }
  return {
    id: profile.userId,
    name: profile.userName,
    displayName: profile.displayName || profile.userName,
    bio: profile.bio,
    iconId: profile.iconFileId,
    iconUrl: await getContentUrl(profile.iconFileId),
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
