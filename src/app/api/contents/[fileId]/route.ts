import { auth } from "@/auth";
import { existsUserPaymentHistory } from "@/lib/db/user-payment-history";
import { drizzle } from "@/drizzle";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse, type NextRequest } from "next/server";
import { file, packagePricing, packages, packageScreenshot, profile, release } from "@/drizzle/schema";
import { eq, count, inArray } from "drizzle-orm";

async function determineVisibility({ fileId, userId }: { fileId: string, userId: string | null }) {
  const db = await drizzle();
  let cacheControl = "private";

  let allowed = false;

  const pkg = await db.select({
    userId: packages.userId,
    published: packages.published,
  }).from(packages)
    .where(eq(packages.iconFileId, fileId));
  const profiles = await db.select({
    cnt: count()
  }).from(profile)
    .where(eq(profile.iconFileId, fileId))
    .then(rows => rows.at(0)?.cnt ?? 0);
  const screenshots = await db.select({
    published: packages.published,
    userId: packages.userId,
  }).from(packageScreenshot)
    .where(eq(packageScreenshot.fileId, fileId))
    .innerJoin(packages, eq(packageScreenshot.packageId, packages.id));
  const releases = await db.select({
    published: release.published,
    packageUserId: packages.userId,
    packagePublished: packages.published,
    packageId: packages.id,
  }).from(release)
    .where(eq(release.fileId, fileId))
    .innerJoin(packages, eq(release.packageId, packages.id));

  if (pkg.length !== 0) {
    allowed = pkg.some(
      (pkg) => pkg.published || pkg.userId === userId,
    );
    cacheControl = pkg.some((pkg) => pkg.published) ? "public" : "private";

    if (allowed) {
      return { allowed, cacheControl };
    }
  }
  if (profiles > 0) {
    allowed = true;
    cacheControl = "public";
    return { allowed, cacheControl };
  }
  if (screenshots.length !== 0) {
    allowed = screenshots.some(
      (screenshot) =>
        screenshot.published ||
        screenshot.userId === userId,
    );
    cacheControl = screenshots.some((screenshot) => screenshot.published) ? "public" : "private";
    if (allowed) {
      return { allowed, cacheControl };
    }
  }
  if (releases.length !== 0) {
    cacheControl = "no-store";
    allowed = releases.some(
      (release) =>
        (release.published && release.packagePublished) ||
        release.packageUserId === userId
    );
    if (allowed) {
      const price = await db.select({
        id: packagePricing.id,
        packageId: packagePricing.packageId,
      })
        .from(packagePricing)
        .where(inArray(packagePricing.packageId, releases.map(r => r.packageId)))

      // 価格が設定されている時、購入者のみアクセス可能
      if (price.length > 0) {
        const r = await Promise.all(price.map(async (p) => {
          return await existsUserPaymentHistory({
            userId: userId || undefined,
            packageId: p.packageId,
          })
        }));

        if (r.some((exists) => !exists)) {
          allowed = false;
          return { allowed, cacheControl, paymentRequired: true };
        } else {
          allowed = true;
          return { allowed, cacheControl };
        }
      }
    }
  }

  return { allowed, cacheControl };
}

export async function GET(request: NextRequest, props: { params: Promise<{ fileId: string }> }) {
  const params = await props.params;

  const {
    fileId
  } = params;

  const session = await auth();
  const db = await drizzle();
  const row = await db.select({
    userId: file.userId,
    visibility: file.visibility,
    mimeType: file.mimeType,
    objectKey: file.objectKey
  }).from(file)
    .where(eq(file.id, fileId))
    .limit(1)
    .then(rows => rows.at(0));

  if (!row) {
    return NextResponse.json(
      {
        message: "ファイルが見つかりません",
      },
      {
        status: 404,
      },
    );
  }

  let cacheControl = "private";

  let allowed = false;
  if (row.visibility === "PUBLIC") {
    allowed = true;
    cacheControl = "public";
  }
  if (row.visibility === "PRIVATE") {
    allowed = session?.user?.id === row.userId;
  }
  if (row.visibility === "DEDICATED") {
    const result = await determineVisibility({
      fileId: fileId,
      userId: session?.user?.id || null,
    });

    if (result.paymentRequired) {
      return NextResponse.json(
        {
          message: "支払いが必要です",
        },
        {
          status: 402,
        },
      );
    }

    allowed = result.allowed;
    cacheControl = result.cacheControl;
  }

  if (allowed) {
    const bucket = (await getCloudflareContext({ async: true })).env.BEUTL_R2_BUCKET;
    const res = await bucket.get(row.objectKey);
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
        "Content-Type": row.mimeType || "application/octet-stream",
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
