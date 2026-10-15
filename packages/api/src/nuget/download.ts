import { byteRangeHeaders, parseByteRange, resolveContentAccess } from "@beutl/core";
import { existsUserPaymentHistory, findFileForContentAccess, getDb } from "@beutl/db";
import { getR2Bucket } from "../ai/r2-provider";
import { tryGetUserIdFromHeaders } from "../api/auth";
import { authenticateNuget } from "./tokens";
import { verifyDownloadTicket } from "./tickets";

const privateHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

export async function downloadPackage(request: Request, fileId: string): Promise<Response> {
  const file = await findFileForContentAccess({ id: fileId });
  if (!file || file.Release.length === 0) return new Response(null, { status: 404, headers: privateHeaders });
  let access = await resolveContentAccess({ file, userId: null, hasPurchasedPackage: async () => false });
  let userId: string | null = null;
  if (access.outcome !== "allowed") {
    const ticket = new URL(request.url).searchParams.get("ticket");
    userId = (ticket ? await verifyDownloadTicket(ticket, fileId) : null) ??
      (await authenticateNuget(request.headers))?.userId ?? await tryGetUserIdFromHeaders(request.headers);
    access = await resolveContentAccess({ file, userId, hasPurchasedPackage: (packageId) => existsUserPaymentHistory({ packageId, userId: userId ?? undefined }) });
  }
  if (access.outcome !== "allowed") return new Response(null, { status: userId ? 403 : 401,
    headers: { ...privateHeaders, "WWW-Authenticate": 'Basic realm="Beutl NuGet"' } });
  const size = Number(file.size);
  const etag = `"${file.sha256 || fileId}"`;
  const range = request.method !== "HEAD" && (!request.headers.has("if-range") || request.headers.get("if-range") === etag)
    ? parseByteRange(request.headers.get("range"), size) : null;
  const headers = { ...privateHeaders, "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "Accept-Ranges": "bytes", ETag: etag, "Content-Length": String(size) };
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...privateHeaders, ...byteRangeHeaders(null, size) } });
  if (request.method === "HEAD") return new Response(null, { headers });
  const object = await getR2Bucket().get?.(file.objectKey, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!object) return new Response(null, { status: 404, headers: privateHeaders });
  // Count full downloads, not HEAD requests or each range used by resumable clients.
  if (!range) await (await getDb()).release.updateMany({ where: { fileId }, data: { downloads: { increment: 1 } } });
  const body = object.body ?? (object.arrayBuffer ? await object.arrayBuffer() : null);
  return new Response(body, { status: range ? 206 : 200, headers: { ...headers, ...(range ? byteRangeHeaders(range, size) : {}) } });
}
