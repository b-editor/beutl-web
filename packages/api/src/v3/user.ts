import { Hono } from "hono";
import { apiErrorResponse } from "../api/error";
import type { Prisma } from "@prisma/client";
import { getUserId } from "../api/auth";
import { getContentUrl } from "../content-url";
import { findProfileForApi } from "@beutl/db";
import { canStartAiOperation, getEntitlements } from "../ai/entitlements";
import {
  isUploadLimitExceeded,
  parseJsonWithBodyLimit,
} from "../ai/upload-limits";
import { z } from "zod";
import { MAX_AI_AUDIO_DURATION_SECONDS } from "../ai/audio-metadata";

const aiAvailabilityRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("image.generate") }).strict(),
  z.object({
    operation: z.enum([
      "image.edit.remove_background",
      "image.edit.upscale",
      "image.edit.restyle",
      "image.edit.remove_object",
      "image.edit.outpaint",
    ]),
  }).strict(),
  z.object({
    operation: z.literal("video.generate"),
    durationSeconds: z.union([z.literal(4), z.literal(6), z.literal(8)]),
  }).strict(),
  z.object({
    operation: z.literal("audio.transcribe"),
    durationSeconds: z.number().finite().positive().max(
      MAX_AI_AUDIO_DURATION_SECONDS,
    ),
  }).strict(),
  z.object({
    operation: z.literal("subtitle.translate"),
    characterCount: z.number().int().positive().max(20_000),
  }).strict(),
]);

export async function getUserProfile(
  query: Prisma.ProfileWhereInput,
  request?: Request,
) {
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
    iconUrl: await getContentUrl(profile.iconFileId, request),
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
  }, c.req.raw);
  if (!profile) {
    return c.json(await apiErrorResponse("userNotFound"), { status: 404 });
  }
  return c.json(profile);
})
  .get("/entitlements", async (c) => {
    const currentUserId = await getUserId(c);
    if (!currentUserId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    return c.json(await getEntitlements(currentUserId));
  })
  .post("/ai-availability", async (c) => {
    const currentUserId = await getUserId(c);
    if (!currentUserId) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }

    let body: unknown;
    try {
      body = await parseJsonWithBodyLimit<unknown>(c.req);
    } catch (error) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: isUploadLimitExceeded(error) ? 413 : 400,
      });
    }
    const parsed = aiAvailabilityRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(await apiErrorResponse("invalidRequestBody"), {
        status: 400,
      });
    }

    return c.json({
      available: await canStartAiOperation(
        currentUserId,
        parsed.data,
      ),
    });
  });

export default app;
