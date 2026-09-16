import { Hono } from "hono";
import { parseStorageListingParams, STORAGE_LIST_PAGE_SIZE } from "@beutl/core";
import {
  getDb,
  retrieveStorageFilesPage,
  retrieveStorageFoldersByUserId,
} from "@beutl/db";
import { getUserId } from "../api/auth";
import { apiErrorResponse } from "../api/error";
import { getStorageEntitlement } from "../storage-entitlements";

// The desktop uses the same listing rules and quota accounting as the Web UI.
const app = new Hono().get("/", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Vary", "Authorization");
  const userId = await getUserId(c);
  if (!userId) {
    return c.json(await apiErrorResponse("authenticationIsRequired"), { status: 401 });
  }

  const prisma = await getDb();
  const folders = await retrieveStorageFoldersByUserId({ userId, prisma });
  const requested = parseStorageListingParams(c.req.query());
  const listing = {
    ...requested,
    // Deleted or foreign folders resolve to this user's root, just as on Web.
    folderId: folders.some((folder) => folder.id === requested.folderId)
      ? requested.folderId
      : null,
  };
  const [page, usage] = await Promise.all([
    retrieveStorageFilesPage({ userId, listing, pageSize: STORAGE_LIST_PAGE_SIZE, prisma }),
    getStorageEntitlement(userId, { prisma }),
  ]);

  return c.json({
    ...page,
    files: page.files.map((file) => ({
      id: file.id,
      name: file.name,
      size: Number(file.size),
      mimeType: file.mimeType,
      visibility: file.visibility,
      createdAt: file.createdAt,
      folderId: file.folderId,
    })),
    folders: folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      createdAt: folder.createdAt,
    })),
    folderId: listing.folderId,
    usage,
  });
});

export default app;
