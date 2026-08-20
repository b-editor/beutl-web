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
// 開始要求の名前。ブラウザが作った UUID で、応答が失われたときの問い合わせ直しに
// 使う。形を絞るのは、他人の行を引き当てる推測をさせないため。
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const { id, name, mimeType, size } = (parsed.value ?? {}) as Record<
    string,
    unknown
  >;
  if (
    typeof id !== "string" ||
    !UUID.test(id) ||
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    // ゼロは枠を 1 バイトも使わないまま R2 のマルチパートと追跡行を作れてしまう。
    // 中身のないファイルを送る用はないので、始めさせない。
    size <= 0 ||
    // Nothing may be started that could not be stored even in an empty account.
    size > STORAGE_QUOTA_BYTES
  ) {
    return Response.json({ error_code: "invalidRequestBody" }, { status: 400 });
  }

  const outcome = await startUpload({
    userId,
    id,
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
