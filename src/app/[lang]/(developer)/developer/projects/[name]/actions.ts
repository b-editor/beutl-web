"use server";

import { uploadFile } from "@/app/[lang]/(storage)/storage/actions";
import { authenticated, throwIfUnauth } from "@/lib/auth-guard";
import { isValidNuGetVersionRange } from "@/lib/nuget-version-range";
import { s3 } from "@/lib/storage";
import { prisma } from "@/prisma";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
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
}

const displayNameAndShortDescriptionSchema = z.object({
  displayName: z.string().max(50, "表示名は50文字以下である必要があります"),
  shortDescription: z.string().max(200, "短い説明は200文字以下である必要があります"),
  id: z.string().uuid("IDが不正です"),
});

const releaseSchema = z.object({
  title: z.string().max(50, "タイトルは50文字以下である必要があります"),
  description: z.string().max(1000, "説明は1000文字以下である必要があります"),
  id: z.string().uuid("IDが不正です"),
  targetVersion: z.string().refine((v) => SemVer.valid(v) || isValidNuGetVersionRange(v), "バージョンが不正です"),
  published: z.coerce.boolean(),
  file: z.optional(z.instanceof(File)),
});

async function sameUser<TResult>(
  packageId: string,
  userId: string,
  fnc: () => Promise<TResult>
) {
  const pkg = await prisma.package.findFirst({
    where: {
      id: packageId,
    },
    select: {
      userId: true,
    }
  });
  if (!pkg) {
    return {
      success: false,
      message: "IDが見つかりません",
    };
  }

  if (pkg.userId !== userId) {
    return {
      success: false,
      message: "権限がありません",
    };
  }

  return await fnc();
}

async function createDedicatedFile(userId: string, file: File, size: bigint) {
  const files = await prisma.file.findMany({
    where: {
      userId: userId,
    },
    select: {
      size: true,
      name: true,
    },
  });

  const maxSize = BigInt(1024 * 1024 * 1024); // 1GB
  let totalSize = BigInt(0);
  for (const file of files) {
    totalSize += BigInt(file.size);
  }
  totalSize -= size;

  if (totalSize + BigInt(file.size) > maxSize) {
    return {
      success: false,
      message: "ストレージ容量が足りません",
    };
  }

  let filename = file.name;
  const ext = file.name.split(".").pop();
  for (let i = 1; files.some((f) => f.name === filename); i++) {
    filename = ext
      ? file.name.replace(`.${ext}`, ` (${i}).${ext}`)
      : `${file.name} (${i})`;
  }

  const objectKey = randomUUID();
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET as string,
      Key: objectKey,
      Body: new Uint8Array(await file.arrayBuffer()),
      ServerSideEncryption: "AES256",
    }),
  );
  const record = await prisma.file.create({
    data: {
      objectKey,
      name: filename,
      size: file.size,
      mimeType: file.type,
      userId: userId,
      visibility: "DEDICATED",
    },
  });

  return {
    success: true,
    record
  };
}

export async function updateDisplayNameAndShortDescription(state: State, formData: FormData): Promise<State> {
  return await authenticated(async session => {
    const validated = displayNameAndShortDescriptionSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!validated.success) {
      return {
        errors: validated.error.flatten().fieldErrors,
        message: "入力内容に誤りがあります",
        success: false,
      };
    }

    const { displayName, shortDescription, id } = validated.data;
    return await sameUser(id, session.user.id, async () => {
      const { name } = await prisma.package.update({
        where: {
          id,
        },
        data: {
          displayName,
          shortDescription,
        },
        select: {
          name: true
        }
      });
      revalidatePath(`/developer/projects/${name}`);
      return {
        success: true
      };
    });
  });
}

export async function updateDescription({ packageId, description }: { packageId: string, description: string }): Promise<Response> {
  return await authenticated(async session => {
    if (description.length > 1000) {
      return {
        message: "説明は1000文字以下である必要があります",
        success: false,
      };
    }

    return await sameUser(packageId, session.user.id, async () => {
      const { name } = await prisma.package.update({
        where: {
          id: packageId
        },
        data: {
          description,
        },
        select: {
          name: true,
        },
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
  const pkg = await prisma.package.findFirst({
    where: {
      name: {
        equals: name,
        mode: "insensitive"
      },
      userId: session.user.id
    },
    select: {
      id: true,
      name: true,
      displayName: true,
      description: true,
      shortDescription: true,
      published: true,
      webSite: true,
      tags: true,
      user: {
        select: {
          Profile: {
            select: {
              userName: true,
            }
          }
        }
      },
      iconFile: {
        select: {
          id: true,
          objectKey: true,
        }
      },
      PackageScreenshot: {
        select: {
          order: true,
          file: {
            select: {
              id: true,
              objectKey: true,
            }
          }
        },
        orderBy: {
          order: "asc"
        }
      },
      Release: {
        select: {
          version: true,
          title: true,
          description: true,
          targetVersion: true,
          id: true,
          published: true,
          file: {
            select: {
              name: true
            }
          }
        }
      }
    }
  });
  if (!pkg) {
    return null;
  }
  pkg.Release.sort((a, b) => {
    return new SemVer.SemVer(b.version).compare(a.version);
  });
  const screenshots = await Promise.all(pkg.PackageScreenshot.map(async (item) => {
    return {
      ...item,
      url: `/api/contents/${item.file.id}`
    }
  }));

  return {
    ...pkg,
    iconFileUrl: pkg.iconFile && `/api/contents/${pkg.iconFile.id}`,
    PackageScreenshot: screenshots
  };
}

export async function deletePackage(id: string): Promise<Response> {
  return await authenticated(async (session) => {
    return await sameUser(id, session.user.id, async () => {
      const pkg = await prisma.package.findFirstOrThrow({
        where: {
          id,
        },
        select: {
          id: true,
          PackageScreenshot: {
            select: {
              file: {
                select: {
                  id: true,
                  objectKey: true,
                },
              },
            },
          },
          iconFile: {
            select: {
              id: true,
              objectKey: true,
            },
          },
          Release: {
            select: {
              file: {
                select: {
                  id: true,
                  objectKey: true,
                },
              },
            },
          },
        },
      });

      const files = pkg.PackageScreenshot.map((item) => item.file).concat(
        pkg.Release.map((item) => item.file as NonNullable<typeof item.file>),
      );
      if (pkg.iconFile) {
        files.push(pkg.iconFile);
      }
      await prisma.package.delete({
        where: {
          id,
        },
      });
      const promises = files.map(async (file) => {
        await prisma.file.delete({
          where: {
            id: file.id,
          },
        });
        await s3.send(
          new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET as string,
            Key: file.objectKey,
          }),
        );
      });

      await Promise.all(promises);
      revalidatePath("/developer");
      redirect("/developer");
    });
  });
}

export async function changePackageVisibility(id: string, published: boolean): Promise<Response> {
  return await authenticated(async (session) => {
    return await sameUser(id, session.user.id, async () => {
      const { name } = await prisma.package.update({
        where: {
          id,
        },
        data: {
          published,
        },
        select: {
          name: true,
        },
      });
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
      const { name, iconFile } = await prisma.package.findFirstOrThrow({
        where: { id },
        select: {
          name: true,
          iconFile: {
            select: {
              id: true,
              objectKey: true,
              size: true
            },
          },
        },
      });

      const deletedSize = iconFile ? BigInt(iconFile.size) : BigInt(0);
      const result = await createDedicatedFile(session.user.id, file, deletedSize);
      if (!result.success) {
        return {
          success: result.success,
          message: result.message
        }
      }

      if (iconFile) {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET as string,
            Key: iconFile.objectKey,
          }),
        );
        await prisma.file.delete({
          where: {
            id: iconFile.id,
          },
        });
      }

      await prisma.package.update({
        where: {
          id,
        },
        data: {
          // biome-ignore lint/style/noNonNullAssertion: <explanation>
          iconFileId: result.record!.id,
        },
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
      const { name } = await prisma.package.findFirstOrThrow({
        where: { id, userId: session.user.id },
        select: { id: true, name: true },
      });

      const result = await createDedicatedFile(session.user.id, file, BigInt(0));
      if (!result.success) {
        return result;
      }
      const lastScreenshot = await prisma.packageScreenshot.findFirst({
        where: {
          packageId: id,
        },
        select: {
          order: true,
        },
        orderBy: {
          order: "desc",
        },
      });
      await prisma.packageScreenshot.create({
        data: {
          order: (lastScreenshot?.order || 0) + 1,
          packageId: id,
          // biome-ignore lint/style/noNonNullAssertion: <explanation>
          fileId: result.record!.id,
        },
      });
      revalidatePath(`/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

export async function moveScreenshot({ delta, packageId, fileId }: { delta: number, packageId: string, fileId: string }): Promise<Response> {
  return await authenticated(async (session) => {
    return await sameUser(packageId, session.user.id, async () => {
      const { name } = await prisma.package.findFirstOrThrow({
        where: {
          id: packageId,
        },
      });
      const sign = Math.sign(delta);
      const all = await prisma.packageScreenshot.findMany({
        where: {
          packageId: packageId,
        },
        orderBy: {
          order: "asc",
        },
      });

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
          await prisma.packageScreenshot.update({
            where: {
              packageId_fileId: {
                packageId: packageId,
                fileId: item.fileId,
              },
            },
            data: {
              order: item.order,
            },
          });
        });
      await Promise.all(promises);
      revalidatePath(`/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

export async function deleteScreenshot({ packageId, fileId }: { packageId: string, fileId: string }): Promise<Response> {
  return await authenticated(async (session) => {
    return await sameUser(packageId, session.user.id, async () => {
      const { name } = await prisma.package.findFirstOrThrow({
        where: {
          id: packageId,
        },
        select: {
          name: true
        }
      });
      await prisma.packageScreenshot.delete({
        where: {
          packageId_fileId: {
            packageId,
            fileId,
          },
        },
      });
      await prisma.file.delete({
        where: {
          id: fileId,
        },
      });
      revalidatePath(`/developer/projects/${name}`);
      return {
        success: true,
      };
    });
  });
}

export async function updateTag({ packageId, tags }: { packageId: string, tags: string[] }): Promise<Response> {
  return await authenticated(async (session) => {
    return await sameUser(packageId, session.user.id, async () => {
      const { name } = await prisma.package.update({
        where: {
          id: packageId,
        },
        data: {
          tags,
        },
        select: {
          name: true
        }
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
    const validated = releaseSchema.safeParse(Object.fromEntries(formData.entries()));
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
            size: true
          }
        }
      }
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
        const deletedSize = release.file ? BigInt(release.file.size) : BigInt(0);
        const result = await createDedicatedFile(session.user.id, validated.data.file, deletedSize);
        if (!result.success) {
          return {
            success: result.success,
            message: result.message
          }
        }

        if (release.file) {
          await s3.send(
            new DeleteObjectCommand({
              Bucket: process.env.S3_BUCKET as string,
              Key: release.file.objectKey,
            }),
          );
          await prisma.file.delete({
            where: {
              id: release.file.id,
            },
          });
        }
        // biome-ignore lint/style/noNonNullAssertion: <explanation>
        fileId = result.record!.id;
      }

      const data = await prisma.release.update({
        where: {
          id: validated.data.id,
        },
        data: {
          title: validated.data.title,
          description: validated.data.description,
          targetVersion: validated.data.targetVersion,
          published: validated.data.published,
          fileId: fileId
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
              name: true
            }
          }
        }
      });

      return {
        success: true,
        data
      };
    });
  });
}

export async function createRelease({ packageId, version }: { packageId: string, version: string }) {
  return await authenticated(async (session) => {
    return await sameUser(packageId, session.user.id, async () => {
      if (SemVer.valid(version) === null) {
        return {
          success: false,
          message: "バージョンが不正です"
        };
      }

      const release = await prisma.release.create({
        data: {
          packageId,
          version,
          title: "新しいリリース",
          description: "",
          targetVersion: "1.0.0-preview.10",
          published: false
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
              name: true
            }
          }
        }
      });
      return {
        success: true,
        data: release
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
        file: {
          select: {
            id: true,
            objectKey: true,
          }
        }
      }
    });
    if (!release?.packageId) {
      return {
        success: false,
        message: "IDが見つかりません",
      };
    }
    return await sameUser(release.packageId, session.user.id, async () => {
      if (release.file) {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET as string,
            Key: release.file.objectKey,
          }),
        );
        await prisma.file.delete({
          where: {
            id: release.file.id,
          },
        });
      }
      await prisma.release.delete({
        where: {
          id: releaseId,
        },
      });
      return {
        success: true,
      };
    });
  });
}