import { auth } from "@/auth";
import { existsUserPaymentHistory } from "@/lib/db/user-payment-history";
import { s3 } from "@/lib/storage";
import { prisma } from "@/prisma";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse, type NextRequest } from "next/server";

export async function GET(
  request: NextRequest,
  { params: { fileId } }: { params: { fileId: string } },
) {
  const session = await auth();
  const file = await prisma.file.findFirst({
    where: {
      id: fileId,
    },
    select: {
      objectKey: true,
      visibility: true,
      userId: true,
      Package: {
        select: {
          userId: true,
          published: true,
        },
      },
      Profile: true,
      PackageScreenshot: {
        select: {
          package: {
            select: {
              userId: true,
              published: true,
            },
          },
        },
      },
      Release: {
        select: {
          published: true,
          package: {
            select: {
              id: true,
              userId: true,
              published: true,
              packagePricing: {
                select: {
                  id: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!file) {
    return NextResponse.json(
      {
        message: "ファイルが見つかりません",
      },
      {
        status: 404,
      },
    );
  }

  let allowed = file.visibility === "PUBLIC";
  if (file.visibility === "PRIVATE") {
    allowed = session?.user?.id === file.userId;
  }
  if (file.visibility === "DEDICATED") {
    if (file.Package.length !== 0) {
      allowed = file.Package.some(
        (pkg) => pkg.published || pkg.userId === session?.user?.id,
      );
    }
    if (file.Profile) {
      allowed = true;
    }
    if (file.PackageScreenshot.length !== 0) {
      allowed = file.PackageScreenshot.some(
        (screenshot) =>
          screenshot.package.published ||
          screenshot.package.userId === session?.user?.id,
      );
    }
    if (file.Release.length !== 0) {
      allowed = file.Release.some(
        (release) =>
          (release.published && release.package.published) ||
          release.package.userId === session?.user?.id,
      );
      if (allowed) {
        const pkg = file.Release.find((r) => r.package)?.package;
        // 価格が設定されている時、購入者のみアクセス可能
        if (pkg?.packagePricing[0]?.id) {
          if (
            !(await existsUserPaymentHistory({
              userId: session?.user?.id,
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
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET as string,
        Key: file.objectKey,
      }),
    );
    if (!res?.Body) {
      return NextResponse.json(
        {
          message: "ファイルが見つかりません",
        },
        {
          status: 404,
        },
      );
    }
    return new NextResponse(await res.Body.transformToByteArray(), {
      headers: {
        "Content-Type": res.ContentType || "",
        "Content-Length": res.ContentLength?.toString() || "",
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
