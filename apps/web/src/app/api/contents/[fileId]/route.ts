import { byteRangeHeaders, parseByteRange, resolveContentAccess } from "@beutl/core";
import {
  existsUserPaymentHistory,
  findFileForContentAccess,
} from "@beutl/db";
import { tryGetUserIdFromHeaders } from "@beutl/api";
import { getR2Bucket } from "@beutl/api/ai/r2-provider";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/better-auth";
import {
  contentCacheHeaders,
  contentDeliveryHeaders,
  contentDisposition,
  contentEntityTag,
  matchesContentEntityTag,
} from "@/lib/content-cache";
import { getImageContentCache } from "@/lib/image-content-cache";
import { getContentImageVariant } from "@/lib/content-image-transform";

type ContentProps = { params: Promise<{ fileId: string }> };

export async function GET(
  request: NextRequest,
  props: ContentProps,
) {
  return serveContent(request, props, false);
}

/** Return representation metadata without fetching or encoding an image body. */
export async function HEAD(request: NextRequest, props: ContentProps) {
  const headers = new Headers(request.headers);
  // RFC 9110 only defines Range for GET. HEAD describes the full representation.
  headers.delete("range");
  headers.delete("if-range");
  const headRequest = new Request(request.url, { method: "HEAD", headers, signal: request.signal });
  const response = await serveContent(headRequest as NextRequest, props, true);
  void response.body?.cancel().catch(() => {});
  return new NextResponse(null, { status: response.status, headers: response.headers });
}

async function serveContent(
  request: NextRequest,
  props: ContentProps,
  headOnly: boolean,
) {
  const { fileId } = await props.params;
  const file = await findFileForContentAccess({ id: fileId });
  if (!file) {
    return NextResponse.json(
      {
        message: "ファイルが見つかりません",
      },
      {
        status: 404,
        headers: contentCacheHeaders(false),
      },
    );
  }

  // Public images need no session/JWT lookup. Determine anonymous access using
  // the same policy, then authenticate only content that requires it.
  let access = await resolveContentAccess({
    file,
    userId: null,
    hasPurchasedPackage: async () => false,
  });
  if (access.outcome !== "allowed") {
    const session = await auth.api.getSession({ headers: request.headers });
    const userId = session?.user?.id ?? (await tryGetUserIdFromHeaders(request.headers));
    access = await resolveContentAccess({
      file,
      userId,
      hasPurchasedPackage: async (packageId) =>
        await existsUserPaymentHistory({ userId: userId ?? undefined, packageId }),
    });
  }

  if (access.outcome === "allowed") {
    const etag = contentEntityTag(file);
    const deliveryHeaders = contentDeliveryHeaders(file.mimeType);
    const headers = {
      ...deliveryHeaders,
      "Content-Disposition": contentDisposition(deliveryHeaders["Content-Disposition"], file.name),
      ...contentCacheHeaders(access.canUsePublicCache),
      ETag: etag,
    };
    const variant = getContentImageVariant(request, file);
    const variantHeaders = variant ? {
      ...headers,
      "Content-Type": "image/webp",
      "Content-Disposition": contentDisposition("inline", `${file.name.replace(/\.[^.]*$/u, "")}.webp`),
      ETag: variant.etag,
      "Accept-Ranges": "none",
    } : headers;
    // Originals have known metadata; variants must be cached or generated
    // before revalidation, since a failed transformation changes the response.
    // Private/paid content retains no-store and always receives a full response.
    if (access.canUsePublicCache && !variant &&
      matchesContentEntityTag(request.headers.get("if-none-match"), variantHeaders.ETag)) {
      return new NextResponse(null, { status: 304, headers: variantHeaders });
    }
    if (headOnly) {
      const cache = variant ? await getImageContentCache(request, file, variant.key) : null;
      const cached = await cache?.match();
      let headHeaders: Record<string, string>;
      if (cached) {
        headHeaders = { ...variantHeaders, "Content-Length": cached.headers.get("Content-Length")! };
        void cached.body?.cancel().catch(() => {});
      } else if (!variant || variant.isPaused()) {
        headHeaders = { ...headers, "Content-Length": file.size.toString(), "Accept-Ranges": "bytes" };
      } else {
        // An uncached encoding may succeed or fall back. RFC 9110 9.3.2 permits
        // omitting fields determined only while producing the response body.
        // Do not advertise the original's metadata for a potential WebP GET.
        headHeaders = contentCacheHeaders(access.canUsePublicCache);
      }
      const notModified = access.canUsePublicCache && headHeaders.ETag !== undefined &&
        matchesContentEntityTag(request.headers.get("if-none-match"), headHeaders.ETag);
      return new NextResponse(null, { status: notModified ? 304 : 200, headers: headHeaders });
    }
    // Media players seek with one byte range at a time.
    const size = Number(file.size);
    const ifRange = request.headers.get("if-range");
    const range = parseByteRange(
      ifRange === null || (ifRange === etag && !etag.startsWith("W/"))
        ? request.headers.get("range")
        : null,
      size,
    );
    if (range === "unsatisfiable") {
      return new NextResponse(null, {
        status: 416,
        headers: { ...byteRangeHeaders(null, size), ...contentCacheHeaders(false) },
      });
    }
    const variantCache = variant ? await getImageContentCache(request, file, variant.key) : null;
    const cachedVariant = await variantCache?.match();
    if (cachedVariant) {
      if (access.canUsePublicCache && matchesContentEntityTag(request.headers.get("if-none-match"), variantHeaders.ETag)) {
        void cachedVariant.body?.cancel().catch(() => {});
        return new NextResponse(null, { status: 304, headers: variantHeaders });
      }
      return new NextResponse(cachedVariant.body, {
        headers: { ...variantHeaders, "Content-Length": cachedVariant.headers.get("Content-Length")! },
      });
    }
    if (variant?.isPaused() && access.canUsePublicCache &&
      matchesContentEntityTag(request.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, { status: 304, headers });
    }
    const deliver = async (source: NextResponse) => {
      if (!variant) return source;
      const bytes = await variant.transform(source);
      if (!bytes) {
        if (access.canUsePublicCache && matchesContentEntityTag(request.headers.get("if-none-match"), etag)) {
          void source.body?.cancel().catch(() => {});
          return new NextResponse(null, { status: 304, headers });
        }
        return source;
      }
      const response = new NextResponse(bytes, {
        headers: { ...variantHeaders, "Content-Length": bytes.byteLength.toString() },
      });
      variantCache?.put(response);
      void source.body?.cancel().catch(() => {});
      if (access.canUsePublicCache && matchesContentEntityTag(request.headers.get("if-none-match"), variantHeaders.ETag)) {
        void response.body?.cancel().catch(() => {});
        return new NextResponse(null, { status: 304, headers: variantHeaders });
      }
      return response;
    };
    // Cache only whole images; a partial response must never replace the full
    // object. This check runs after the live visibility and payment checks.
    const cache = range ? null : await getImageContentCache(request, file);
    const cached = await cache?.match();
    if (cached) {
      return deliver(new NextResponse(cached.body, {
        headers: { ...headers, "Content-Length": size.toString(), "Accept-Ranges": "bytes" },
      }));
    }
    const bucket = getR2Bucket();
    if (!bucket.get) {
      throw new Error("The configured storage bucket cannot read objects");
    }
    const object = await bucket.get(
      file.objectKey,
      range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined,
    );
    if (!object) {
      return NextResponse.json(
        {
          message: "ファイルが見つかりません",
        },
        {
          status: 404,
          headers: contentCacheHeaders(false),
        },
      );
    }

    const body = object.body ?? (object.arrayBuffer ? await object.arrayBuffer() : null);
    if (body === null) {
      throw new Error(`Storage object ${file.objectKey} cannot be read`);
    }
    const response = new NextResponse(body, {
      headers: {
        ...headers,
        ...(range
          ? byteRangeHeaders(range, size)
          : typeof object.size === "number"
            ? { "Content-Length": object.size.toString() }
            : {}),
        "Accept-Ranges": "bytes",
      },
      status: range ? 206 : 200,
    });
    cache?.put(response);
    return deliver(response);
  }

  if (access.outcome === "payment-required") {
    return NextResponse.json(
      {
        message: "支払いが必要です",
      },
      {
        status: 403,
        headers: contentCacheHeaders(false),
      },
    );
  }

  return NextResponse.json(
    {
      message: "ファイルが見つかりません",
    },
    {
      status: 404,
      headers: contentCacheHeaders(false),
    },
  );
}
