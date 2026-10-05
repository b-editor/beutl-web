import { isGitRepositoryId, isGitRevision, isGitTreePath, mimeTypeFromFileName } from "@beutl/core";
import { ownsActiveGitRepository } from "@beutl/api/git/repositories";
import { readRepositoryFile } from "@beutl/api/git/repository-browser";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/better-auth";
import { contentCacheHeaders, contentDeliveryHeaders, contentDisposition } from "@/lib/content-cache";
import { GitRepositoryError, hostedGit } from "@/lib/git-repositories";

// Facts about the bytes that pass through from storage; the type and
// disposition come from the file name, as the content route decides them.
const PASSED_HEADERS = ["content-length", "content-range", "accept-ranges", "etag", "last-modified"];

function unavailable(status: 404 | 503): NextResponse {
  return new NextResponse(null, { status, headers: contentCacheHeaders(false) });
}

/**
 * One file of a repository at a commit, for its owner's dashboard: previews
 * stream it with byte ranges and downloads save it. Anyone else, and any
 * missing ref or path, gets the same 404.
 */
export async function GET(request: NextRequest, props: { params: Promise<{ repositoryId: string }> }) {
  const { repositoryId } = await props.params;
  const query = new URL(request.url).searchParams;
  const ref = query.get("ref") ?? "";
  const path = query.get("path") ?? "";
  if (!isGitRepositoryId(repositoryId) || !isGitRevision(ref) || !isGitTreePath(path) || path === "") {
    return unavailable(404);
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return unavailable(404);
  let env;
  try {
    ({ env } = await hostedGit());
  } catch (error) {
    if (error instanceof GitRepositoryError) return unavailable(503);
    throw error;
  }
  if (!await ownsActiveGitRepository(session.user.id, repositoryId)) return unavailable(404);

  const file = await readRepositoryFile(
    env, { repoId: repositoryId, ownerId: session.user.id, scope: "read" }, request, ref, path,
  );
  if (!file) return unavailable(404);
  const delivery = contentDeliveryHeaders(mimeTypeFromFileName(file.entry.name));
  const headers = new Headers({
    ...delivery,
    "Content-Disposition": contentDisposition(delivery["Content-Disposition"], file.entry.name),
    ...contentCacheHeaders(false),
  });
  for (const name of PASSED_HEADERS) {
    const value = file.response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new NextResponse(file.response.body, { status: file.response.status, headers });
}
