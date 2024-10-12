"use server"

import { auth } from "@/auth";
import { s3 } from "@/lib/storage";
import { prisma } from "@/prisma";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SemVer } from "semver";

export type Package = {
  id: string;
  name: string;
  displayName?: string;
  iconFileUrl?: string;
  latestVersion?: string;
  published: boolean;
};

export async function retrievePackages(): Promise<Package[]> {
  const session = await auth();
  if (!session?.user?.id) {
    return [];
  }
  const packages = await prisma.package.findMany({
    where: {
      userId: session.user.id
    },
    select: {
      id: true,
      name: true,
      displayName: true,
      published: true,
      iconFile: {
        select: {
          objectKey: true
        }
      },
      Release: {
        select: {
          version: true
        }
      }
    }
  });

  return await Promise.all(packages.map(async (pkg) => {
    const iconFileUrl = pkg.iconFile && await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET as string,
        Key: pkg.iconFile.objectKey,
      }),
    );
    pkg.Release.sort((a, b) => {
      return new SemVer(a.version).compare(b.version);
    });
    return {
      id: pkg.id,
      name: pkg.name,
      displayName: pkg.displayName || undefined,
      iconFileUrl: iconFileUrl || undefined,
      latestVersion: pkg.Release[0]?.version,
      published: pkg.published
    };
  }));
}