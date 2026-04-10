import { auth } from "@/lib/better-auth";
import { existsUserPaymentHistory } from "@/lib/db/user-payment-history";
import { getDbAsync } from "@/db";
import { file } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse, type NextRequest } from "next/server";
import { tryGetUserIdFromHeaders } from "@/lib/api/auth";

export async function GET(request: NextRequest, props: { params: Promise<{ fileId: string }> }) {
  const params = await props.params;

  const {
    fileId
  } = params;

  const session = await auth.api.getSession({ headers: request.headers });
  const userId = session?.user?.id || await tryGetUserIdFromHeaders(request.headers);

  const db = await getDbAsync();
  const fileResult = await db.query.file.findFirst({
    where: eq(file.id, fileId),
    columns: {
      objectKey: true,
      visibility: true,
      userId: true,
      mimeType: true,
    },
    with: {
      packages: {
        columns: {
          userId: true,
          published: true,
        },
      },
      profiles: true,
      packageScreenshots: {
        with: {
          package: {
            columns: {
              userId: true,
              published: true,
            },
          },
        },
      },
      releases: {
        columns: {
          published: true,
        },
        with: {
          package: {
            columns: {
              id: true,
              userId: true,
              published: true,
            },
            with: {
              packagePricings: {
                columns: {
                  id: true,
                },
              },
            },
          },
        },
      },
    },
  });
  let cacheControl = "private";

  if (!fileResult) {
    return NextResponse.json(
      {
        message: "ファイルが見つかりません",
      },
      {
        status: 404,
      },
    );
  }

  let allowed = false;
  if (fileResult.visibility === "PUBLIC") {
    allowed = true;
    cacheControl = "public";
  }
  if (fileResult.visibility === "PRIVATE") {
    allowed = userId === fileResult.userId;
  }
  if (fileResult.visibility === "DEDICATED") {
    if (fileResult.packages.length !== 0) {
      allowed = fileResult.packages.some(
        (pkg) => pkg.published || pkg.userId === userId,
      );
      cacheControl = fileResult.packages.some((pkg) => pkg.published) ? "public" : "private";
    }
    if (fileResult.profiles.length !== 0) {
      allowed = true;
      cacheControl = "public";
    }
    if (fileResult.packageScreenshots.length !== 0) {
      allowed = fileResult.packageScreenshots.some(
        (screenshot) =>
          screenshot.package.published ||
          screenshot.package.userId === userId,
      );
      cacheControl = fileResult.packageScreenshots.some((screenshot) => screenshot.package.published) ? "public" : "private";
    }
    if (fileResult.releases.length !== 0) {
      cacheControl = "no-store";
      allowed = fileResult.releases.some(
        (releaseItem) =>
          (releaseItem.published && releaseItem.package.published) ||
          releaseItem.package.userId === userId,
      );
      if (allowed) {
        const pkg = fileResult.releases.find((r) => r.package)?.package;
        // 価格が設定されている時、購入者のみアクセス可能
        if (pkg?.packagePricings[0]?.id) {
          if (
            !(await existsUserPaymentHistory({
              userId: userId || undefined,
              packageId: pkg.id,
            }))
          ) {
            return NextResponse.json(
              {
                message: "支払いが必要です",
              },
              {
                status: 403,
              },
            );
          }
        }
      }
    }
  }

  if (allowed) {
    const bucket = getCloudflareContext().env.BEUTL_R2_BUCKET;
    const res = await bucket.get(fileResult.objectKey);
    if (!res) {
      return NextResponse.json(
        {
          message: "ファイルが見つかりません",
        },
        {
          status: 404,
        },
      );
    }

    return new NextResponse(res.body, {
      headers: {
        "Content-Type": fileResult.mimeType || "application/octet-stream",
        "Content-Length": res.size.toString(),
        "Cache-Control": cacheControl !== "no-store" ? `${cacheControl}, max-age=31536000, immutable` : cacheControl,
      },
      status: 200,
    });
  }
  return NextResponse.json(
    {
      message: "アクセスが拒否されました",
    },
    {
      status: 403,
    },
  );
}
