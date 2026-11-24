import { isGitRepositoryId } from "@beutl/core";
import { readGitRepositoryThumbnail } from "@beutl/api/git/thumbnails";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/better-auth";
import { contentCacheHeaders, contentDeliveryHeaders, contentDisposition } from "@/lib/content-cache";
import { GitRepositoryError, hostedGit } from "@/lib/git-repositories";

function unavailable(status: 404 | 503): NextResponse {
  return new NextResponse(null, { status, headers: contentCacheHeaders(false) });
}

async function serveThumbnail(
  request: NextRequest,
  props: { params: Promise<{ repositoryId: string }> },
  headOnly: boolean,
): Promise<NextResponse> {
  const { repositoryId } = await props.params;
  if (!isGitRepositoryId(repositoryId)) return unavailable(404);

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return unavailable(404);

  let env;
  try {
    ({ env } = await hostedGit());
  } catch (error) {
    if (error instanceof GitRepositoryError) return unavailable(503);
    throw error;
  }

  const thumbnail = await readGitRepositoryThumbnail(env, session.user.id, repositoryId, { headOnly });
  if (!thumbnail) return unavailable(404);

  const delivery = contentDeliveryHeaders("image/png");
  const headers = new Headers({
    ...delivery,
    "Content-Disposition": contentDisposition(delivery["Content-Disposition"], "thumbnail.png"),
    "Content-Length": String(thumbnail.size),
    ...contentCacheHeaders(false),
  });
  return new NextResponse(headOnly ? null : thumbnail.body ?? null, { status: 200, headers });
}

/** Private thumbnail for a repository owned by the signed-in dashboard user. */
export async function GET(request: NextRequest, props: { params: Promise<{ repositoryId: string }> }) {
  return serveThumbnail(request, props, false);
}

export async function HEAD(request: NextRequest, props: { params: Promise<{ repositoryId: string }> }) {
  return serveThumbnail(request, props, true);
}
