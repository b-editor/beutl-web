import "server-only";
import { getDbAsync } from "@/prisma";
import type { PrismaTransaction } from "./transaction";

export async function getProfileByUserId(
  userId: string,
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? await getDbAsync();
  return await db.profile.findFirst({
    where: {
      userId,
    },
  });
}

export async function getProfileDisplayNameByUserName({
  userName,
  prisma,
}: {
  userName: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma || await getDbAsync();
  return await db.profile.findFirst({
    where: {
      userName: userName,
    },
    select: {
      displayName: true,
    },
  });
}

export async function getSocialProfilesByUserId(
  userId: string,
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? await getDbAsync();
  return await db.socialProfile.findMany({
    where: {
      userId,
    },
    select: {
      value: true,
      provider: {
        select: {
          id: true,
          name: true,
          provider: true,
          urlTemplate: true,
        },
      },
    },
  });
}

export async function upsertProfile({
  userId,
  displayName,
  userName,
  bio,
  prisma,
}: {
  userId: string;
  displayName: string;
  userName: string;
  bio?: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.profile.upsert({
    where: {
      userId,
    },
    update: {
      displayName,
      userName,
      bio,
    },
    create: {
      userId,
      displayName,
      userName,
      bio,
    },
  });
}

export async function getSocialProviders(
  providers: string[],
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? await getDbAsync();
  return await db.socialProfileProvider.findMany({
    where: {
      provider: {
        in: providers,
      },
    },
    select: {
      id: true,
      provider: true,
    },
  });
}

export async function upsertSocialProfile({
  userId,
  providerId,
  value,
  prisma,
}: {
  userId: string;
  providerId: string;
  value: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.socialProfile.upsert({
    where: {
      userId_providerId: {
        userId,
        providerId,
      },
    },
    update: {
      value,
    },
    create: {
      userId,
      providerId,
      value,
    },
  });
}

export async function deleteSocialProfiles({
  userId,
  providerId,
  prisma,
}: {
  userId: string;
  providerId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDbAsync();
  return await db.socialProfile.deleteMany({
    where: {
      userId,
      providerId,
    },
  });
}
