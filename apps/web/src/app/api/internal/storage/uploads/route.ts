import { auth } from "@/lib/better-auth";
import {
  fromThisSite,
  readJsonWithLimit,
  unauthorizedResponse,
} from "@/lib/internal-request";
import { startUpload } from "@/lib/storage-upload-server";
import { STORAGE_QUOTA_BYTES } from "@beutl/core";

// Starting an upload that will arrive in parts. What comes back is the id every
// later request names, and how the file is to be cut up.

const MAX_NAME_LENGTH = 255;
const MAX_CONTROL_BODY_BYTES = 4 * 1024;

export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return unauthorizedResponse();

  const session = await auth.api.getSession({ headers: request.headers });
  const userId = session?.user?.id;
  if (!userId) return unauthorizedResponse();

  // A name, a type and a size. Nothing here is large.
  const parsed = await readJsonWithLimit(request, MAX_CONTROL_BODY_BYTES);
  if (!parsed.ok) {
    return Response.json({ error_code: "invalidRequestBody" }, { status: 400 });
  }

  const { name, mimeType, size } = (parsed.value ?? {}) as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    // Nothing may be started that could not be stored even in an empty account.
    size > STORAGE_QUOTA_BYTES
  ) {
    return Response.json({ error_code: "invalidRequestBody" }, { status: 400 });
  }

  const outcome = await startUpload({
    userId,
    name,
    mimeType: typeof mimeType === "string" ? mimeType : "application/octet-stream",
    size: BigInt(size),
  });
  if (!outcome.ok) {
    return Response.json(
      { error_code: outcome.reason },
      { status: outcome.reason === "insufficientStorageSpace" ? 409 : 400 },
    );
  }

  return Response.json(outcome.upload, { status: 201 });
}
