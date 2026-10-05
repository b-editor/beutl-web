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
} from "@/lib/content-cache";

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await props.params;
  const session = await auth.api.getSession({ headers: request.headers });
  const userId =
    session?.user?.id ?? (await tryGetUserIdFromHeaders(request.headers));

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

  const access = await resolveContentAccess({
    file,
    userId,
    hasPurchasedPackage: async (packageId) =>
      await existsUserPaymentHistory({
        userId: userId ?? undefined,
        packageId,
      }),
  });

  if (access.outcome === "allowed") {
    const bucket = getR2Bucket();
    if (!bucket.get) {
      throw new Error("The configured storage bucket cannot read objects");
    }
    // Media players seek with one byte range at a time.
    const size = Number(file.size);
    const range = parseByteRange(request.headers.get("range"), size);
    if (range === "unsatisfiable") {
      return new NextResponse(null, {
        status: 416,
        headers: { ...byteRangeHeaders(null, size), ...contentCacheHeaders(false) },
      });
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

    const deliveryHeaders = contentDeliveryHeaders(file.mimeType);
    const body = object.body ?? (object.arrayBuffer ? await object.arrayBuffer() : null);
    if (body === null) {
      throw new Error(`Storage object ${file.objectKey} cannot be read`);
    }
    return new NextResponse(body, {
      headers: {
        ...(range
          ? byteRangeHeaders(range, size)
          : typeof object.size === "number"
            ? { "Content-Length": object.size.toString() }
            : {}),
        "Accept-Ranges": "bytes",
        ...deliveryHeaders,
        "Content-Disposition": contentDisposition(
          deliveryHeaders["Content-Disposition"],
          file.name,
        ),
        ...contentCacheHeaders(access.canUsePublicCache),
      },
      status: range ? 206 : 200,
    });
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
