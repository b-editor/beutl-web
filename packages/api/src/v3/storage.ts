import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  boundedBody,
  MAX_API_JSON_REQUEST_BYTES,
  STORAGE_PAGE_SIZE,
  STORAGE_PAGE_SIZE_MAX,
  storageFileActions,
} from "@beutl/core";
import {
  getDb,
  retrieveStorageEntries,
  storageFolderSummary,
  STORAGE_ENTRY_FILE_SELECT,
} from "@beutl/db";
import { getUserId } from "../api/auth";
import { apiErrorResponse, apiOnErrorHandler } from "../api/error";
import { getStorageEntitlement } from "../storage-entitlements";
import { getContentUrl } from "../content-url";
import { getR2Bucket } from "../ai/r2-provider";
import {
  StorageOperationError,
  storageIdSchema,
  parseStorageInput,
  createManagedFolder,
  updateManagedFolder,
  updateManagedFiles,
  deleteManagedFiles,
  deleteManagedFolder,
  runManagedFileBatch,
} from "../storage/management";

const cursorSchema = z
  .object({
    version: z.literal(1),
    parentId: storageIdSchema.nullable(),
    foldersOnly: z.boolean(),
    kind: z.enum(["folder", "file"]),
    name: z.string().max(255),
    id: storageIdSchema,
  })
  .strict();
const querySchema = z
  .object({
    parentId: storageIdSchema.nullable(),
    cursor: z.string().max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(STORAGE_PAGE_SIZE_MAX),
    kind: z.literal("folder").optional(),
  })
  .strict();

function folderDto(folder: {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
}

async function jsonBody(c: Context): Promise<unknown> {
  if (
    !c.req.header("Content-Type")?.toLowerCase().startsWith("application/json") ||
    !c.req.raw.body
  )
    throw new StorageOperationError("invalidRequestBody");
  try {
    return await new Response(boundedBody(c.req.raw.body, MAX_API_JSON_REQUEST_BYTES)).json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new StorageOperationError("invalidRequestBody");
    throw error;
  }
}

// A cursor is a versioned continuation, not an offset. It is bound to its folder and filter;
// authorization is always re-evaluated and every DB query remains owner-scoped.
function decodeCursor(raw: string, parentId: string | null, foldersOnly: boolean) {
  try {
    const bytes = Uint8Array.from(atob(raw.replace(/-/gu, "+").replace(/_/gu, "/")), (c) =>
      c.charCodeAt(0),
    );
    const cursor = cursorSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (
      cursor.parentId !== parentId ||
      cursor.foldersOnly !== foldersOnly ||
      (foldersOnly && cursor.kind !== "folder")
    )
      throw new Error();
    return cursor;
  } catch {
    throw new StorageOperationError("invalidStorageCursor");
  }
}
function encodeCursor(value: z.infer<typeof cursorSchema>) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

const app = new Hono<{ Variables: { storageUserId: string } }>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Vary", "Authorization");
    const userId = await getUserId(c);
    if (!userId) return c.json(await apiErrorResponse("authenticationIsRequired"), 401);
    c.set("storageUserId", userId);
    await next();
  })
  .get("/entries", async (c) => {
    const parsed = querySchema.safeParse({
      ...c.req.query(),
      parentId: c.req.query("parentId") ?? null,
      limit: c.req.query("limit") ?? STORAGE_PAGE_SIZE,
    });
    if (!parsed.success) throw new StorageOperationError("invalidStorageQuery");
    const query = parsed.data;
    const foldersOnly = query.kind === "folder";
    const cursor = query.cursor ? decodeCursor(query.cursor, query.parentId, foldersOnly) : null;
    const result = await retrieveStorageEntries({
      userId: c.get("storageUserId"),
      parentId: query.parentId,
      cursor,
      limit: query.limit,
      foldersOnly,
    });
    if (result.kind !== "found") throw new StorageOperationError("storageFolderNotFound");
    const entries = result.entries.map((entry) =>
      entry.kind === "file"
        ? {
            id: entry.id,
            kind: entry.kind,
            name: entry.name,
            parentId: entry.parentId,
            size: Number(entry.size),
            mimeType: entry.mimeType,
            visibility: entry.visibility,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            actions: storageFileActions(entry.visibility),
          }
        : { ...folderDto(entry), kind: entry.kind, actions: ["open", "rename", "move", "delete"] },
    );
    const last = entries.at(-1);
    return c.json({
      parentId: query.parentId,
      path: result.path.map(folderDto),
      entries,
      nextCursor:
        result.hasMore && last
          ? encodeCursor({
              version: 1,
              parentId: query.parentId,
              foldersOnly,
              kind: last.kind,
              name: last.name,
              id: last.id,
            })
          : null,
    });
  })
  .get("/usage", async (c) => {
    const prisma = await getDb();
    return c.json(await getStorageEntitlement(c.get("storageUserId"), { prisma }));
  })
  .post("/folders", async (c) => {
    const result = await createManagedFolder(c.get("storageUserId"), await jsonBody(c));
    c.header("Location", `/api/v3/storage/folders/${encodeURIComponent(result.id)}`);
    return c.json(result, 201);
  })
  .get("/folders/:id", async (c) => {
    const id = parseStorageInput(storageIdSchema, c.req.param("id"));
    const result = await storageFolderSummary(c.get("storageUserId"), id);
    if (!result) throw new StorageOperationError("storageFolderNotFound");
    return c.json({
      ...result,
      folder: folderDto(result.folder),
      ancestors: result.ancestors.map(folderDto),
    });
  })
  .patch("/folders/:id", async (c) => {
    await updateManagedFolder(c.get("storageUserId"), c.req.param("id"), await jsonBody(c));
    return c.body(null, 204);
  })
  .delete("/folders/:id", async (c) => {
    const query = c.req.query();
    if (
      Object.keys(query).some((key) => key !== "recursive") ||
      (query.recursive !== undefined && query.recursive !== "true" && query.recursive !== "false")
    )
      throw new StorageOperationError("invalidRequestBody");
    return c.json(
      await deleteManagedFolder(
        c.get("storageUserId"),
        c.req.param("id"),
        query.recursive === "true",
      ),
    );
  })
  .get("/files/:id", async (c) => {
    const id = parseStorageInput(storageIdSchema, c.req.param("id"));
    const db = await getDb();
    const file = await db.file.findFirst({
      where: { id, userId: c.get("storageUserId"), aiJobResult: null },
      select: STORAGE_ENTRY_FILE_SELECT,
    });
    if (!file) throw new StorageOperationError("storageFileNotFound");
    return c.json({
      id: file.id,
      kind: "file",
      name: file.name,
      parentId: file.folderId,
      size: Number(file.size),
      mimeType: file.mimeType,
      visibility: file.visibility,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      actions: storageFileActions(file.visibility),
      contentUrl: await getContentUrl(file.id, c.req.raw),
    });
  })
  .get("/files/:id/content", async (c) => {
    const id = parseStorageInput(storageIdSchema, c.req.param("id"));
    const db = await getDb();
    const file = await db.file.findFirst({
      where: { id, userId: c.get("storageUserId"), aiJobResult: null },
      select: { name: true, objectKey: true },
    });
    if (!file) throw new StorageOperationError("storageFileNotFound");
    const bucket = getR2Bucket();
    if (!bucket.get) throw new Error("Storage cannot read objects");
    const object = await bucket.get(file.objectKey);
    if (!object) throw new StorageOperationError("storageFileNotFound");
    const body = object.body ?? (object.arrayBuffer ? await object.arrayBuffer() : null);
    if (body === null) throw new Error("Storage object cannot be read");
    const fallback = file.name.replace(/[^\x20-\x7e]|["\\]/gu, "_");
    c.header("Content-Type", "application/octet-stream");
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Content-Disposition",
      `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    );
    if (typeof object.size === "number") c.header("Content-Length", String(object.size));
    return c.body(body);
  })
  .patch("/files/:id", async (c) => {
    await updateManagedFiles(c.get("storageUserId"), [c.req.param("id")], await jsonBody(c));
    return c.body(null, 204);
  })
  .delete("/files/:id", async (c) => {
    await deleteManagedFiles(c.get("storageUserId"), [c.req.param("id")]);
    return c.body(null, 204);
  })
  .post("/files/batch", async (c) =>
    c.json(await runManagedFileBatch(c.get("storageUserId"), await jsonBody(c))),
  )
  .onError(async (error, c) => {
    if (error instanceof StorageOperationError) {
      const status = error.code.startsWith("invalid")
        ? 400
        : error.code.endsWith("NotFound")
          ? 404
          : 409;
      return c.json(await apiErrorResponse(error.code), status);
    }
    return apiOnErrorHandler(error, c);
  });

export default app;
