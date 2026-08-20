import { auth } from "@/lib/better-auth";
import {
  fromThisSite,
  readJsonWithLimit,
  unauthorizedResponse,
} from "@/lib/internal-request";
import { cancelUpload, finishUpload } from "@/lib/storage-upload-server";
import { STORAGE_QUOTA_BYTES, STORAGE_UPLOAD_PART_BYTES } from "@beutl/core";

const MAX_PART_COUNT = Math.ceil(STORAGE_QUOTA_BYTES / STORAGE_UPLOAD_PART_BYTES);
const MAX_ETAG_LENGTH = 256;
const MAX_CONTROL_BODY_BYTES = 64 * 1024;

// Finishing an upload, or giving it up.
//
// POST joins the parts into the file; DELETE throws them away. An upload that
// is neither finished nor given up keeps its parts, and their storage, which is
// why the browser says which one happened and a sweep settles the rest.

export async function POST(
  request: Request,
  props: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!fromThisSite(request)) return unauthorizedResponse();

  const session = await auth.api.getSession({ headers: request.headers });
  const userId = session?.user?.id;
  if (!userId) return unauthorizedResponse();

  const parsed = await readJsonWithLimit(request, MAX_CONTROL_BODY_BYTES);
  if (!parsed.ok) {
    return Response.json({ error_code: "invalidRequestBody" }, { status: 400 });
  }

  const parts = (parsed.value as { parts?: unknown })?.parts;
  if (
    !Array.isArray(parts) ||
    parts.length === 0 ||
    // The whole quota cut into parts is what an upload can ever have; a longer
    // list describes an upload that could not exist.
    parts.length > MAX_PART_COUNT ||
    !parts.every(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        Number.isSafeInteger((part as { partNumber?: unknown }).partNumber) &&
        typeof (part as { etag?: unknown }).etag === "string" &&
        (part as { etag: string }).etag.length <= MAX_ETAG_LENGTH,
    )
  ) {
    return Response.json({ error_code: "invalidRequestBody" }, { status: 400 });
  }

  const { id } = await props.params;
  const outcome = await finishUpload({
    userId,
    uploadId: id,
    parts: parts as { partNumber: number; etag: string }[],
  });
  if (!outcome.ok) {
    return Response.json(
      { error_code: outcome.reason },
      {
        status: outcome.reason === "uploadNotFound"
          ? 404
          : outcome.reason === "insufficientStorageSpace"
            ? 409
            : 400,
      },
    );
  }

  return Response.json({
    id: outcome.file.id,
    name: outcome.file.name,
    size: Number(outcome.file.size),
  });
}

export async function DELETE(
  request: Request,
  props: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!fromThisSite(request)) return unauthorizedResponse();

  const session = await auth.api.getSession({ headers: request.headers });
  const userId = session?.user?.id;
  if (!userId) return unauthorizedResponse();

  const { id } = await props.params;
  await cancelUpload({ userId, uploadId: id });
  // Given up either way: a request to forget an upload that is already gone has
  // got what it asked for.
  return new Response(null, { status: 204 });
}
