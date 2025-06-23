import "server-only";
import { drizzle } from "@/drizzle";
import type { Transaction } from "./transaction";
import { packages, release, user, profile, file, packageScreenshot } from "@/drizzle/schema";
import { eq, and, ilike, count, asc, desc } from "drizzle-orm";

export async function retrieveDevPackagesByUserId({
  userId,
  transaction,
}: {
  userId: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  const rows = await db.select()
    .from(packages)
    .leftJoin(release, eq(packages.id, release.packageId))
    .where(eq(packages.userId, userId));

  const result = rows.reduce<Record<string, { Package: typeof packages.$inferSelect; Release: typeof release.$inferSelect[] }>>(
    (acc, row) => {
      if (!acc[row.Package.id]) {
        acc[row.Package.id] = { Package: row.Package, Release: [] };
      }
      if (row.Release) {
        acc[row.Package.id].Release.push(row.Release);
      }
      return acc;
    },
    {}
  );

  return result;
}

export async function retrieveDevPackageByName({
  name,
  userId,
  transaction,
}: {
  name: string;
  userId: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  // パッケージ本体
  const pkg = await db.select()
    .from(packages)
    .where(and(ilike(packages.name, name), eq(packages.userId, userId)))
    .limit(1);

  if (!pkg[0]) return null;

  // ユーザー情報
  const userRow = await db.select({
    userName: profile.userName,
  })
    .from(user)
    .leftJoin(profile, eq(user.id, profile.userId))
    .where(eq(user.id, pkg[0].userId))
    .limit(1);

  // アイコンファイル
  const iconFile = pkg[0].iconFileId
    ? (await db.select({
      id: file.id,
      objectKey: file.objectKey,
    })
      .from(file)
      .where(eq(file.id, pkg[0].iconFileId))
      .limit(1))[0] ?? null
    : null;

  // スクリーンショット
  const screenshots = await db.select({
    order: packageScreenshot.order,
    file: {
      id: file.id,
      objectKey: file.objectKey,
    },
  })
    .from(packageScreenshot)
    .innerJoin(file, eq(packageScreenshot.fileId, file.id))
    .where(eq(packageScreenshot.packageId, pkg[0].id))
    .orderBy(asc(packageScreenshot.order));

  // リリース
  const releases = await db.select({
    version: release.version,
    title: release.title,
    description: release.description,
    targetVersion: release.targetVersion,
    id: release.id,
    published: release.published,
    file: {
      name: file.name,
    },
  })
    .from(release)
    .leftJoin(file, eq(release.fileId, file.id))
    .where(eq(release.packageId, pkg[0].id));

  return {
    ...pkg[0],
    user: userRow[0].userName as string,
    iconFile,
    screenshots,
    releases,
  };
}

export async function existsPackageName({
  name,
  transaction,
}: {
  name: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  return await db.select({ count: count() })
    .from(packages)
    .where(ilike(packages.name, name))
    .then(rows => rows.at(0)?.count ?? 0);
}

export async function createDevPackage({
  name,
  userId,
  transaction,
}: {
  name: string;
  userId: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  const [inserted] = await db
    .insert(packages)
    .values({
      name: name,
      userId: userId,
      description: "",
      shortDescription: "",
      webSite: "",
      published: false,
    })
    .returning();
  return inserted;
}

export async function getUserIdFromPackageId({
  packageId,
  transaction,
}: {
  packageId: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  return await db.select({ userId: packages.userId })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1)
    .then(rows => rows.at(0)?.userId || null);
}

export async function getPackageNameFromPackageId({
  packageId,
  transaction,
}: {
  packageId: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  return await db.select({ name: packages.name })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1)
    .then(r => r.at(0)?.name || null);
}

export async function updateDevPackageDisplay({
  packageId,
  displayName,
  shortDescription,
  transaction,
}: {
  packageId: string;
  displayName: string;
  shortDescription: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  return (await db.update(packages)
    .set({
      displayName: displayName,
      shortDescription: shortDescription,
    })
    .where(eq(packages.id, packageId))
    .returning({ name: packages.name }))
    .at(0);
}

export async function updateDevPackageDescription({
  packageId,
  description,
  transaction,
}: {
  packageId: string;
  description: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  return (await db.update(packages)
    .set({
      description: description,
    })
    .where(eq(packages.id, packageId))
    .returning({ name: packages.name }))
    .at(0);
}

export async function updateDevPackagePublished({
  published,
  packageId,
  transaction,
}: {
  published: boolean;
  packageId: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  return (await db.update(packages)
    .set({
      published: published,
    })
    .where(eq(packages.id, packageId))
    .returning({ name: packages.name }))
    .at(0);
}

export async function updateDevPackageIconFile({
  packageId,
  fileId,
  transaction,
}: {
  packageId: string;
  fileId: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  return (await db.update(packages)
    .set({
      iconFileId: fileId,
    })
    .where(eq(packages.id, packageId))
    .returning({ name: packages.name }))
    .at(0);
}

export async function retrieveDevPackageDependsFile({
  packageId,
  transaction,
}: {
  packageId: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  const pkg = (await db.select()
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1))
    .at(0);
  if (!pkg) {
    throw new Error(`Package with ID ${packageId} not found`);
  }

  const screenshotFiles = await db.select({
    id: file.id,
    objectKey: file.objectKey,
  })
    .from(packageScreenshot)
    .innerJoin(file, eq(packageScreenshot.fileId, file.id))
    .where(eq(packageScreenshot.packageId, pkg.id));
  const iconFile = pkg.iconFileId
    ? (await db.select({
      id: file.id,
      objectKey: file.objectKey,
    })
      .from(file)
      .where(eq(file.id, pkg.iconFileId))
      .limit(1)).at(0) ?? null
    : null;
  const releaseFiles = await db.select({
    id: file.id,
    objectKey: file.objectKey,
  })
    .from(release)
    .innerJoin(file, eq(release.fileId, file.id))
    .where(eq(release.packageId, pkg.id));
  const result = screenshotFiles.concat(releaseFiles);
  if (iconFile) {
    result.push(iconFile);
  }
  return result;
}

export async function retrieveDevPackageIconFile({
  packageId,
  transaction,
}: {
  packageId: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  // パッケージのアイコンファイルを取得
  return await db.select({
    id: file.id,
    objectKey: file.objectKey,
    size: file.size,
  })
    .from(packages)
    .innerJoin(file, eq(packages.iconFileId, file.id))
    .where(eq(packages.id, packageId))
    .limit(1)
    .then(rows => rows.at(0));
}

export async function retrieveDevPackageScreenshots({
  packageId,
  transaction,
}: {
  packageId: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  return await db.select({
    order: packageScreenshot.order,
    fileId: packageScreenshot.fileId,
  })
    .from(packageScreenshot)
    .where(eq(packageScreenshot.packageId, packageId))
    .orderBy(asc(packageScreenshot.order));
}

export async function retrieveDevPackageLastScreenshotOrder({
  packageId,
  transaction,
}: {
  packageId: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  return await db.select({
    order: packageScreenshot.order,
  })
    .from(packageScreenshot)
    .where(eq(packageScreenshot.packageId, packageId))
    .orderBy(desc(packageScreenshot.order))
    .limit(1)
    .then(rows => rows.at(0));
}

export async function createDevPackageScreenshot({
  packageId,
  fileId,
  order,
  transaction,
}: {
  packageId: string;
  fileId: string;
  order: number;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  return await db.insert(packageScreenshot)
    .values({
      packageId: packageId,
      fileId: fileId,
      order: order,
    })
    .returning();
}

export async function updateDevPackageScreenshotOrder({
  packageId,
  fileId,
  order,
  transaction,
}: {
  packageId: string;
  fileId: string;
  order: number;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  return await db.update(packageScreenshot)
    .set({
      order: order,
    })
    .where(and(eq(packageScreenshot.packageId, packageId), eq(packageScreenshot.fileId, fileId)))
    .returning();
}

export async function updateDevPackageTags({
  packageId,
  tags,
  transaction,
}: {
  packageId: string;
  tags: string[];
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  return await db.update(packages)
    .set({
      tags: tags,
    })
    .where(eq(packages.id, packageId))
    .returning({ name: packages.name })
    .then(rows => rows.at(0));
}

export async function deleteDevPackageScreenshot({
  packageId,
  fileId,
  transaction,
}: {
  packageId: string;
  fileId: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  return await db.delete(packageScreenshot)
    .where(and(eq(packageScreenshot.packageId, packageId), eq(packageScreenshot.fileId, fileId)))
    .returning();
}

export async function deleteDevPackage({
  packageId,
  transaction,
}: {
  packageId: string;
  transaction?: Transaction;
}) {
  const db = transaction || (await drizzle());
  return await db.delete(packages)
    .where(eq(packages.id, packageId))
    .returning();
}
