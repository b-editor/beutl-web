import { Hono } from "hono";
import { z } from "zod";
import {
  boundedBody,
  STORAGE_MAX_FILE_BYTES,
  STORAGE_UPLOAD_FINISH_BODY_BYTES,
  STORAGE_MULTIPART_MAX_PARTS,
  STORAGE_UPLOAD_ETAG_MAX_LENGTH,
} from "@beutl/core";
import { startUpload, uploadPart, finishUpload, cancelUpload } from "../storage/uploads";
import { parseStorageInput, StorageOperationError } from "../storage/management";

const startSchema = z
  .object({
    id: z.uuid(),
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\u0000-\u001f\u007f/\\]+$/u),
    mimeType: z.string().min(1).max(255),
    size: z.number().int().positive().max(STORAGE_MAX_FILE_BYTES),
  })
  .strict();
const partsSchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            partNumber: z.number().int().min(1).max(STORAGE_MULTIPART_MAX_PARTS),
            etag: z.string().min(1).max(STORAGE_UPLOAD_ETAG_MAX_LENGTH),
          })
          .strict(),
      )
      .min(1)
      .max(STORAGE_MULTIPART_MAX_PARTS),
  })
  .strict();
async function body(request: Request, limit: number) {
  if (
    !request.headers.get("content-type")?.toLowerCase().startsWith("application/json") ||
    !request.body
  )
    throw new StorageOperationError("invalidRequestBody");
  try {
    return await new Response(boundedBody(request.body, limit)).json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new StorageOperationError("invalidRequestBody");
    throw error;
  }
}
export default new Hono<{ Variables: { storageUserId: string } }>()
  .post("/", async (c) => {
    const input = parseStorageInput(startSchema, await body(c.req.raw, 4096));
    const result = await startUpload({
      ...input,
      userId: c.get("storageUserId"),
      size: BigInt(input.size),
    });
    if (!result.ok)
      return c.json(
        { error_code: result.reason },
        result.reason === "tooManyUploads"
          ? 429
          : result.conflict ||
              result.reason === "insufficientStorageSpace" ||
              result.reason === "tooManyFiles"
            ? 409
            : 400,
      );
    return c.json(result.upload, 201);
  })
  .put("/:id/parts/:part", async (c) => {
    const id = parseStorageInput(z.uuid(), c.req.param("id"));
    const partNumber = Number(c.req.param("part"));
    const length = c.req.header("content-length");
    if (
      !c.req.raw.body ||
      !Number.isSafeInteger(partNumber) ||
      partNumber < 1 ||
      length === undefined ||
      !/^\d+$/u.test(length) ||
      !Number.isSafeInteger(Number(length))
    )
      throw new StorageOperationError("invalidRequestBody");
    const bounded = boundedBody(c.req.raw.body, Number(length));
    // R2 needs workerd's known-length stream even after the outer body guard
    // wraps the request. S3 adapters use the explicit contentLength option.
    const FixedLength = (
      globalThis as unknown as {
        FixedLengthStream?: new (size: number) => {
          readable: ReadableStream<Uint8Array>;
          writable: WritableStream<Uint8Array>;
        };
      }
    ).FixedLengthStream;
    const fixed = FixedLength ? new FixedLength(Number(length)) : null;
    const abort = new AbortController();
    const pumping = fixed ? bounded.pipeTo(fixed.writable, { signal: abort.signal }) : null;
    void pumping?.catch(() => {});
    try {
      const result = await uploadPart({
        userId: c.get("storageUserId"),
        uploadId: id,
        partNumber,
        contentLength: Number(length),
        body: fixed?.readable ?? bounded,
      });
      if (result.ok) await pumping;
      return result.ok
        ? c.json({ partNumber, etag: result.etag })
        : c.json({ error_code: result.reason }, result.reason === "uploadNotFound" ? 404 : 400);
    } finally {
      abort.abort();
      // A rejected upload never reads the stream. Release its backpressure so
      // rejecting a foreign/missing upload cannot wait forever on a queued write.
      if (fixed && !fixed.readable.locked) await fixed.readable.cancel().catch(() => {});
    }
  })
  .post("/:id/complete", async (c) => {
    const id = parseStorageInput(z.uuid(), c.req.param("id"));
    const input = parseStorageInput(
      partsSchema,
      await body(c.req.raw, STORAGE_UPLOAD_FINISH_BODY_BYTES),
    );
    const result = await finishUpload({
      userId: c.get("storageUserId"),
      uploadId: id,
      parts: input.parts,
    });
    return result.ok
      ? c.json({ id: result.file.id, name: result.file.name, size: Number(result.file.size) })
      : c.json(
          { error_code: result.reason },
          result.reason === "uploadNotFound"
            ? 404
            : result.reason === "insufficientStorageSpace"
              ? 409
              : 400,
        );
  })
  .delete("/:id", async (c) => {
    const result = await cancelUpload({
      userId: c.get("storageUserId"),
      uploadId: parseStorageInput(z.uuid(), c.req.param("id")),
    });
    return c.body(null, result === "cancelled" ? 204 : result === "pending" ? 503 : 404);
  });
