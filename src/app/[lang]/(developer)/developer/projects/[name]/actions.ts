"use server";

import { addAuditLog, auditLogActions } from "@/lib/audit-log";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import {
  createDevPackageScreenshot,
  deleteDevPackage,
  deleteDevPackageScreenshot,
  getPackageNameFromPackageId,
  getUserIdFromPackageId,
  retrieveDevPackageByName,
  retrieveDevPackageDependsFile,
  retrieveDevPackageIconFile,
  retrieveDevPackageLastScreenshotOrder,
  retrieveDevPackageScreenshots,
  updateDevPackageDescription,
  updateDevPackageDisplay,
  updateDevPackageIconFile,
  updateDevPackagePublished,
  updateDevPackageScreenshotOrder,
  updateDevPackageTags,
} from "@/lib/db/package";
import { isValidNuGetVersionRange } from "@/lib/nuget-version-range";
import {
  calcTotalFileSize,
  createStorageFile,
  deleteStorageFile,
  s3,
} from "@/lib/storage";
import { prisma } from "@/prisma";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import SemVer from "semver";
import { z } from "zod";

export type State = {
  errors?: {
    displayName?: string[];
    shortDescription?: string[];
  };
  success?: boolean;
  message?: string | null;
};
type Response = {
  success: boolean;
  message?: string;
};

const displayNameAndShortDescriptionSchema = z.object({
  displayName: z.string().max(50, "表示名は50文字以下である必要があります"),
  shortDescription: z
    .string()
    .max(200, "短い説明は200文字以下である必要があります"),
  id: z.string().uuid("IDが不正です"),
});

const releaseSchema = z.object({
  title: z.string().max(50, "タイトルは50文字以下である必要があります"),
  description: z.string().max(1000, "説明は1000文字以下である必要があります"),
  id: z.string().uuid("IDが不正です"),
  targetVersion: z
    .string()
    .refine(
      (v) => SemVer.valid(v) || isValidNuGetVersionRange(v),
      "バージョンが不正です",
    ),
  published: z
    .string()
    .refine((v) => v === "on" || v === "off", "公開設定が不正です"),
  file: z.optional(z.instanceof(File)),
});

async function sameUser<TResult>(
  packageId: string,
  userId: string,
  fnc: () => Promise<TResult>,
) {
  const pkgUserId = await getUserIdFromPackageId({ packageId });
  if (!pkgUserId) {
    return {
      success: false,
      message: "IDが見つかりません",
    };
  }

  if (pkgUserId !== userId) {
    return {
      success: false,
      message: "権限がありません",
    };
  }

  return await fnc();
}

async function createDedicatedFile(userId: string, file: File, size: bigint) {
  const maxSize = BigInt(1024 * 1024 * 1024); // 1GB
  let totalSize = await calcTotalFileSize({ userId, prisma });
  totalSize -= size;

  if (totalSize + BigInt(file.size) > maxSize) {
    return {
      success: false,
      message: "ストレージ容量が足りません",
    };
  }

  const record = await createStorageFile({
    file,
    visibility: "DEDICATED",
    userId,
  });

  return {
    success: true,
    record,
  };
}

export async function updateDisplayNameAndShortDescription(
  state: State,
  formData: FormData,
): Promise<State> {
  return await authenticated(async (session) => {
    const validated = displayNameAndShortDescriptionSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!validated.success) {
      return {
        errors: validated.error.flatten().fieldErrors,
        message: "入力内容に誤りがあります",
        success: false,
      };
    }

    const { displayName, shortDescription, id } = validated.data;
    return await sameUser(id, session.user.id, async () => {
      const { name } = await updateDevPackageDisplay({
        packageId: id,
        displayName,
        shortDescription,
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${id}`,
      });
      revalidatePath(`/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

export async function updateDescription({
  packageId,
  description,
}: { packageId: string; description: string }): Promise<Response> {
  return await authenticated(async (session) => {
    if (description.length > 1000) {
      return {
        message: "説明は1000文字以下である必要があります",
        success: false,
      };
    }

    return await sameUser(packageId, session.user.id, async () => {
      const { name } = await updateDevPackageDescription({
        packageId,
        description,
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${packageId}`,
      });
      revalidatePath(`/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

export async function retrievePackage(name: string) {
  const session = await throwIfUnauth();
  const pkg = await retrieveDevPackageByName({ name, userId: session.user.id });
  if (!pkg) {
    return null;
  }
  pkg.Release.sort((a, b) => {
    return new SemVer.SemVer(b.version).compare(a.version);
  });
  const screenshots = await Promise.all(
    pkg.PackageScreenshot.map(async (item) => {
      return {
        ...item,
        url: `/api/contents/${item.file.id}`,
      };
    }),
  );

  return {
    ...pkg,
    iconFileUrl: pkg.iconFile && `/api/contents/${pkg.iconFile.id}`,
    PackageScreenshot: screenshots,
  };
}

export async function deletePackage(id: string): Promise<Response> {
  return await authenticated(async (session) => {
    return await sameUser(id, session.user.id, async () => {
      const files = await retrieveDevPackageDependsFile({ packageId: id });
      await deleteDevPackage({ packageId: id });
      const promises = files.map(async (file) => {
        await deleteStorageFile({
          fileId: file.id,
        });
      });

      await Promise.all(promises);
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.deletePackage,
        details: `packageId: ${id}`,
      });
      revalidatePath("/developer");
      redirect("/developer");
    });
  });
}

export async function changePackageVisibility(
  id: string,
  published: boolean,
): Promise<Response> {
  return await authenticated(async (session) => {
    return await sameUser(id, session.user.id, async () => {
      const { published: oldPublished } = await prisma.package.findFirstOrThrow(
        {
          where: {
            id,
          },
          select: {
            published: true,
          },
        },
      );
      const { name } = await updateDevPackagePublished({
        packageId: id,
        published,
      });
      if (oldPublished !== published) {
        await addAuditLog({
          userId: session.user.id,
          action: published
            ? auditLogActions.developer.publishPackage
            : auditLogActions.developer.unpublishPackage,
          details: `packageId: ${id}`,
        });
      }
      revalidatePath(`/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

export async function uploadIcon(formData: FormData): Promise<Response> {
  return await authenticated(async (session) => {
    const file = formData.get("file") as File;
    if (!file) {
      return {
        success: false,
        message: "ファイルが見つかりません",
      };
    }
    const id = formData.get("id") as string;
    return await sameUser(id, session.user.id, async () => {
      const iconFile = await retrieveDevPackageIconFile({ packageId: id });

      const deletedSize = iconFile ? BigInt(iconFile.size) : BigInt(0);
      const result = await createDedicatedFile(
        session.user.id,
        file,
        deletedSize,
      );
      if (!result.success) {
        return {
          success: result.success,
          message: result.message,
        };
      }

      if (iconFile) {
        await deleteStorageFile({
          fileId: iconFile.id,
        });
      }

      const { name } = await updateDevPackageIconFile({
        packageId: id,
        // biome-ignore lint/style/noNonNullAssertion: <explanation>
        fileId: result.record!.id,
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${id}`,
      });
      revalidatePath(`/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

export async function addScreenshot(formData: FormData): Promise<Response> {
  return await authenticated(async (session) => {
    const file = formData.get("file") as File;
    if (!file) {
      return {
        success: false,
        message: "ファイルが見つかりません",
      };
    }
    const id = formData.get("id") as string;
    return await sameUser(id, session.user.id, async () => {
      const name = await getPackageNameFromPackageId({ packageId: id });
      const result = await createDedicatedFile(
        session.user.id,
        file,
        BigInt(0),
      );
      if (!result.success) {
        return result;
      }
      const lastScreenshot = await retrieveDevPackageLastScreenshotOrder({
        packageId: id,
      });
      await createDevPackageScreenshot({
        packageId: id,
        // biome-ignore lint/style/noNonNullAssertion: <explanation>
        fileId: result.record!.id,
        order: (lastScreenshot?.order || 0) + 1,
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${id}`,
      });
      revalidatePath(`/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

export async function moveScreenshot({
  delta,
  packageId,
  fileId,
}: { delta: number; packageId: string; fileId: string }): Promise<Response> {
  return await authenticated(async (session) => {
    return await sameUser(packageId, session.user.id, async () => {
      const name = getPackageNameFromPackageId({ packageId });
      const sign = Math.sign(delta);
      const all = await retrieveDevPackageScreenshots({ packageId });

      const target = all.find((screenshot) => screenshot.fileId === fileId);
      if (!target) {
        return {
          success: false,
          message: "ファイルが見つかりません",
        };
      }

      const index = all.indexOf(target);
      if (index === 0 && sign < 0) {
        return {
          success: false,
          message: "既に先頭です",
        };
      }
      if (index === all.length - 1 && sign > 0) {
        return {
          success: false,
          message: "既に末尾です",
        };
      }
      all.splice(index, 1);
      all.splice(index + sign, 0, target);
      const promises = all
        .map((item, i) => ({
          ...item,
          order: i,
          originalOrder: item.order,
        }))
        .map(async (item) => {
          if (item.order === item.originalOrder) return;
          await updateDevPackageScreenshotOrder({
            packageId,
            fileId: item.fileId,
            order: item.order,
          });
        });
      await Promise.all(promises);
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${packageId}`,
      });
      revalidatePath(`/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

export async function deleteScreenshot({
  packageId,
  fileId,
}: { packageId: string; fileId: string }): Promise<Response> {
  return await authenticated(async (session) => {
    return await sameUser(packageId, session.user.id, async () => {
      const name = await getPackageNameFromPackageId({ packageId });
      await deleteDevPackageScreenshot({ packageId, fileId });
      await deleteStorageFile({ fileId });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${packageId}`,
      });
      revalidatePath(`/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

export async function updateTag({
  packageId,
  tags,
}: { packageId: string; tags: string[] }): Promise<Response> {
  return await authenticated(async (session) => {
    return await sameUser(packageId, session.user.id, async () => {
      const { name } = await updateDevPackageTags({
        packageId,
        tags,
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updatePackage,
        details: `packageId: ${packageId}`,
      });
      revalidatePath(`/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

export async function updateRelease(formData: FormData) {
  return await authenticated(async (session) => {
    const validated = releaseSchema.safeParse(
      Object.fromEntries(formData.entries()),
    );
    if (!validated.success) {
      return {
        errors: validated.error.flatten().fieldErrors,
        message: "入力内容に誤りがあります",
        success: false,
      };
    }
    const release = await prisma.release.findFirst({
      where: {
        id: validated.data.id,
      },
      select: {
        packageId: true,
        file: {
          select: {
            id: true,
            objectKey: true,
            size: true,
          },
        },
      },
    });
    if (!release?.packageId) {
      return {
        success: false,
        message: "IDが見つかりません",
      };
    }

    return await sameUser(release.packageId, session.user.id, async () => {
      let fileId = release.file?.id;
      if (validated.data.file) {
        const deletedSize = release.file
          ? BigInt(release.file.size)
          : BigInt(0);
        const result = await createDedicatedFile(
          session.user.id,
          validated.data.file,
          deletedSize,
        );
        if (!result.success) {
          return {
            success: result.success,
            message: result.message,
          };
        }

        if (release.file) {
          await deleteStorageFile({
            fileId: release.file.id,
          });
        }
        // biome-ignore lint/style/noNonNullAssertion: <explanation>
        fileId = result.record!.id;
      }

      const { published: oldPublished } = await prisma.release.findFirstOrThrow(
        {
          where: {
            id: validated.data.id,
          },
          select: {
            published: true,
          },
        },
      );
      const data = await prisma.release.update({
        where: {
          id: validated.data.id,
        },
        data: {
          title: validated.data.title,
          description: validated.data.description,
          targetVersion: validated.data.targetVersion,
          published: validated.data.published === "on",
          fileId: fileId,
        },
        select: {
          version: true,
          title: true,
          description: true,
          targetVersion: true,
          id: true,
          published: true,
          file: {
            select: {
              name: true,
            },
          },
        },
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.updateRelease,
        details: `releaseId: ${data.id}`,
      });
      if (oldPublished !== data.published) {
        await addAuditLog({
          userId: session.user.id,
          action: data.published
            ? auditLogActions.developer.publishRelease
            : auditLogActions.developer.unpublishRelease,
          details: `releaseId: ${data.id}`,
        });
      }

      return {
        success: true,
        data,
      };
    });
  });
}

export async function createRelease({
  packageId,
  version,
}: { packageId: string; version: string }) {
  return await authenticated(async (session) => {
    return await sameUser(packageId, session.user.id, async () => {
      if (SemVer.valid(version) === null) {
        return {
          success: false,
          message: "バージョンが不正です",
        };
      }

      const release = await prisma.release.create({
        data: {
          packageId,
          version,
          title: "新しいリリース",
          description: "",
          targetVersion: "1.0.0-preview.10",
          published: false,
        },
        select: {
          version: true,
          title: true,
          description: true,
          targetVersion: true,
          id: true,
          published: true,
          file: {
            select: {
              name: true,
            },
          },
        },
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.createRelease,
        details: `packageId: ${packageId}, releaseId: ${release.id}, version: ${version}`,
      });
      return {
        success: true,
        data: release,
      };
    });
  });
}

export async function deleteRelease({ releaseId }: { releaseId: string }) {
  return await authenticated(async (session) => {
    const release = await prisma.release.findFirst({
      where: {
        id: releaseId,
      },
      select: {
        packageId: true,
        fileId: true,
      },
    });
    if (!release?.packageId) {
      return {
        success: false,
        message: "IDが見つかりません",
      };
    }
    return await sameUser(release.packageId, session.user.id, async () => {
      if (release.fileId) {
        await deleteStorageFile({
          fileId: release.fileId,
        });
      }
      await prisma.release.delete({
        where: {
          id: releaseId,
        },
      });
      await addAuditLog({
        userId: session.user.id,
        action: auditLogActions.developer.deleteRelease,
        details: `releaseId: ${releaseId}`,
      });
      return {
        success: true,
      };
    });
  });
}
