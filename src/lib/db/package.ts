import "server-only";
import { getDbAsync } from "@/db";
import {
  packageTable,
  packagePricing,
  packageScreenshot,
} from "@/db/schema";
import type { PaymentInterval } from "@/db/types";
import { and, asc, count, desc, eq, ilike } from "drizzle-orm";
import type { DbTransaction } from "./transaction";

export async function retrieveDevPackagesByUserId({
  userId,
  tx,
}: {
  userId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  return await db.query.packageTable.findMany({
    where: eq(packageTable.userId, userId),
    columns: {
      id: true,
      name: true,
      displayName: true,
      published: true,
    },
    with: {
      iconFile: {
        columns: { id: true },
      },
      releases: {
        columns: { version: true },
      },
    },
  });
}

export async function retrieveDevPackageByName({
  name,
  userId,
  tx,
}: {
  name: string;
  userId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  return await db.query.packageTable.findFirst({
    where: and(ilike(packageTable.name, name), eq(packageTable.userId, userId)),
    columns: {
      id: true,
      name: true,
      displayName: true,
      description: true,
      shortDescription: true,
      published: true,
      webSite: true,
      tags: true,
      interval: true,
    },
    with: {
      packagePricings: {
        columns: {
          id: true,
          price: true,
          currency: true,
          fallback: true,
        },
      },
      user: {
        columns: {},
        with: {
          profile: {
            columns: { userName: true },
          },
        },
      },
      iconFile: {
        columns: { id: true, objectKey: true },
      },
      packageScreenshots: {
        columns: { order: true },
        with: {
          file: {
            columns: { id: true, objectKey: true },
          },
        },
        orderBy: asc(packageScreenshot.order),
      },
      releases: {
        columns: {
          version: true,
          title: true,
          description: true,
          targetVersion: true,
          id: true,
          published: true,
        },
        with: {
          file: {
            columns: { name: true },
          },
        },
      },
    },
  });
}

export async function existsPackageName({
  name,
  tx,
}: {
  name: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .select({ count: count() })
    .from(packageTable)
    .where(ilike(packageTable.name, name));
  return result[0].count;
}

export async function createDevPackage({
  name,
  userId,
  tx,
}: {
  name: string;
  userId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .insert(packageTable)
    .values({
      name,
      userId,
      description: "",
      shortDescription: "",
      webSite: "",
      published: false,
    })
    .returning();
  return result[0];
}

export async function getUserIdFromPackageId({
  packageId,
  tx,
}: {
  packageId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .select({ userId: packageTable.userId })
    .from(packageTable)
    .where(eq(packageTable.id, packageId))
    .limit(1);
  return result[0]?.userId;
}

export async function getPackageNameFromPackageId({
  packageId,
  tx,
}: {
  packageId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .select({ name: packageTable.name })
    .from(packageTable)
    .where(eq(packageTable.id, packageId))
    .limit(1);
  return result[0]?.name;
}

export async function updateDevPackageDisplay({
  packageId,
  displayName,
  shortDescription,
  tx,
}: {
  packageId: string;
  displayName: string;
  shortDescription: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .update(packageTable)
    .set({ displayName, shortDescription })
    .where(eq(packageTable.id, packageId))
    .returning({ name: packageTable.name });
  return result[0];
}

export async function updateDevPackageDescription({
  packageId,
  description,
  tx,
}: {
  packageId: string;
  description: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .update(packageTable)
    .set({ description })
    .where(eq(packageTable.id, packageId))
    .returning({ name: packageTable.name });
  return result[0];
}

export async function updateDevPackagePublished({
  published,
  packageId,
  tx,
}: {
  published: boolean;
  packageId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .update(packageTable)
    .set({ published })
    .where(eq(packageTable.id, packageId))
    .returning({ name: packageTable.name });
  return result[0];
}

export async function updateDevPackageIconFile({
  packageId,
  fileId,
  tx,
}: {
  packageId: string;
  fileId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .update(packageTable)
    .set({ iconFileId: fileId })
    .where(eq(packageTable.id, packageId))
    .returning({ name: packageTable.name });
  return result[0];
}

export async function retrieveDevPackageDependsFile({
  packageId,
  tx,
}: {
  packageId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const pkg = await db.query.packageTable.findFirst({
    where: eq(packageTable.id, packageId),
    columns: {},
    with: {
      packageScreenshots: {
        columns: {},
        with: {
          file: { columns: { id: true, objectKey: true } },
        },
      },
      iconFile: { columns: { id: true, objectKey: true } },
      releases: {
        columns: {},
        with: {
          file: { columns: { id: true, objectKey: true } },
        },
      },
    },
  });
  if (!pkg) throw new Error(`Package not found: ${packageId}`);

  const files = pkg.packageScreenshots
    .map((item) => item.file)
    .concat(
      pkg.releases
        .map((item) => item.file)
        .filter(
          (f): f is NonNullable<typeof f> => f !== null,
        ),
    );
  if (pkg.iconFile) {
    files.push(pkg.iconFile);
  }
  return files;
}

export async function retrieveDevPackageIconFile({
  packageId,
  tx,
}: {
  packageId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db.query.packageTable.findFirst({
    where: eq(packageTable.id, packageId),
    columns: {},
    with: {
      iconFile: { columns: { id: true, objectKey: true, size: true } },
    },
  });
  return result?.iconFile ?? null;
}

export async function retrieveDevPackageScreenshots({
  packageId,
  tx,
}: {
  packageId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  return await db
    .select({
      order: packageScreenshot.order,
      fileId: packageScreenshot.fileId,
    })
    .from(packageScreenshot)
    .where(eq(packageScreenshot.packageId, packageId))
    .orderBy(asc(packageScreenshot.order));
}

export async function retrieveDevPackageLastScreenshotOrder({
  packageId,
  tx,
}: {
  packageId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .select({ order: packageScreenshot.order })
    .from(packageScreenshot)
    .where(eq(packageScreenshot.packageId, packageId))
    .orderBy(desc(packageScreenshot.order))
    .limit(1);
  return result[0] ?? null;
}

export async function createDevPackageScreenshot({
  packageId,
  fileId,
  order,
  tx,
}: {
  packageId: string;
  fileId: string;
  order: number;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .insert(packageScreenshot)
    .values({ packageId, fileId, order })
    .returning();
  return result[0];
}

export async function updateDevPackageScreenshotOrder({
  packageId,
  fileId,
  order,
  tx,
}: {
  packageId: string;
  fileId: string;
  order: number;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .update(packageScreenshot)
    .set({ order })
    .where(
      and(
        eq(packageScreenshot.packageId, packageId),
        eq(packageScreenshot.fileId, fileId),
      ),
    )
    .returning();
  return result[0];
}

export async function updateDevPackageTags({
  packageId,
  tags,
  tx,
}: {
  packageId: string;
  tags: string[];
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .update(packageTable)
    .set({ tags })
    .where(eq(packageTable.id, packageId))
    .returning({ name: packageTable.name });
  return result[0];
}

export async function deleteDevPackageScreenshot({
  packageId,
  fileId,
  tx,
}: {
  packageId: string;
  fileId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .delete(packageScreenshot)
    .where(
      and(
        eq(packageScreenshot.packageId, packageId),
        eq(packageScreenshot.fileId, fileId),
      ),
    )
    .returning();
  return result[0];
}

export async function deleteDevPackage({
  packageId,
  tx,
}: {
  packageId: string;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .delete(packageTable)
    .where(eq(packageTable.id, packageId))
    .returning();
  return result[0];
}

export async function upsertPackagePricings({
  packageId,
  pricings,
}: {
  packageId: string;
  pricings: { currency: string; price: number; fallback: boolean }[];
}) {
  const db = await getDbAsync();
  await db.transaction(async (tx) => {
    await tx
      .delete(packagePricing)
      .where(eq(packagePricing.packageId, packageId));
    if (pricings.length > 0) {
      await tx.insert(packagePricing).values(
        pricings.map((p) => ({
          packageId,
          currency: p.currency,
          price: p.price,
          fallback: p.fallback,
        })),
      );
    }
  });
}

export async function updatePackageInterval({
  packageId,
  interval,
  tx,
}: {
  packageId: string;
  interval: PaymentInterval | null;
  tx?: DbTransaction;
}) {
  const db = tx || (await getDbAsync());
  const result = await db
    .update(packageTable)
    .set({ interval })
    .where(eq(packageTable.id, packageId))
    .returning({ name: packageTable.name });
  return result[0];
}
