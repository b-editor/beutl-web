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

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ fileId: string }> },
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
    // Revalidate access first, then let a browser reuse unchanged public bytes.
    // Private/paid content retains no-store and always receives a full response.
    if (access.canUsePublicCache && matchesContentEntityTag(request.headers.get("if-none-match"), variantHeaders.ETag)) {
      return new NextResponse(null, { status: 304, headers: variantHeaders });
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
      return new NextResponse(cachedVariant.body, {
        headers: { ...variantHeaders, "Content-Length": cachedVariant.headers.get("Content-Length")! },
      });
    }
    const deliver = async (source: NextResponse) => {
      if (!variant) return source;
      const bytes = await variant.transform(source);
      if (!bytes) return source;
      const response = new NextResponse(bytes, {
        headers: { ...variantHeaders, "Content-Length": bytes.byteLength.toString() },
      });
      variantCache?.put(response);
      void source.body?.cancel().catch(() => {});
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
