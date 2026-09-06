import { resolveContentAccess } from "@beutl/core";
import {
  existsUserPaymentHistory,
  findFileForContentAccess,
} from "@beutl/db";
import { releaseCurrentDbProviderClient } from "@beutl/db/provider-scope";
import { tryGetUserIdFromHeaders } from "@beutl/api";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/better-auth";
import {
  contentCacheHeaders,
  contentDeliveryHeaders,
} from "@/lib/content-cache";

function contentDisposition(disposition: string, fileName: string): string {
  const fallback = fileName
    .replace(/[^\x20-\x7e]/gu, "_")
    .replace(/["\\]/gu, "_");
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

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
    // Authorization is the last database operation on this path. Do not retain
    // Prisma's compiler and pool while a potentially large R2 body is streamed.
    await releaseCurrentDbProviderClient();
    const bucket = getCloudflareContext().env.BEUTL_R2_BUCKET;
    const object = await bucket.get(file.objectKey);
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
    return new NextResponse(object.body, {
      headers: {
        "Content-Length": object.size.toString(),
        ...deliveryHeaders,
        "Content-Disposition": contentDisposition(
          deliveryHeaders["Content-Disposition"],
          file.name,
        ),
        ...contentCacheHeaders(access.canUsePublicCache),
      },
      status: 200,
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
