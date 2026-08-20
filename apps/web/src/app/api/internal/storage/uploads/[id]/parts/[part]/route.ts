import { auth } from "@/lib/better-auth";
import { fromThisSite, unauthorizedResponse } from "@/lib/internal-request";
import { uploadPart } from "@/lib/storage-upload-server";

// One part of a file. The body is handed to the bucket as it arrives rather
// than read into memory: a part is the largest thing this Worker ever holds,
// and it holds none of it.

export async function PUT(
  request: Request,
  props: { params: Promise<{ id: string; part: string }> },
): Promise<Response> {
  if (!fromThisSite(request)) return unauthorizedResponse();

  const session = await auth.api.getSession({ headers: request.headers });
  const userId = session?.user?.id;
  if (!userId) return unauthorizedResponse();

  const { id, part } = await props.params;
  const partNumber = Number(part);
  // The bucket will not take a part whose length it cannot know, and a body
  // sent without a length is exactly that. Said here, where it can be answered
  // with a status, rather than as a failure from the bucket further in. The
  // length itself is checked against what the upload declared.
  const contentLength = Number(request.headers.get("content-length"));
  if (
    !Number.isSafeInteger(partNumber) ||
    !request.body ||
    request.headers.get("content-length") === null ||
    !Number.isSafeInteger(contentLength) ||
    contentLength < 0
  ) {
    return Response.json({ error_code: "invalidRequestBody" }, { status: 400 });
  }

  const outcome = await uploadPart({
    userId,
    uploadId: id,
    partNumber,
    contentLength,
    body: request.body,
  });
  if (!outcome.ok) {
    return Response.json(
      { error_code: outcome.reason },
      { status: outcome.reason === "uploadNotFound" ? 404 : 400 },
    );
  }

  return Response.json({ partNumber, etag: outcome.etag });
}
