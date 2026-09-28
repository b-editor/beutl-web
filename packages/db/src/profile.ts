import { getDb } from "./provider";
import type { Prisma } from "@prisma/client";
import type { PrismaTransaction } from "./transaction";
import { isUniqueConstraintViolation } from "./credit-account";

export class ProfileUserNameTakenError extends Error {
  constructor() {
    super("Profile user name is already in use");
    this.name = "ProfileUserNameTakenError";
  }
}

// Prisma implements insensitive equality with ILIKE. Treat identifiers
// literally: an underscore in a user name must not match another character.
export function profileUserNameFilter(userName: string) {
  return {
    equals: userName.replace(/[\\%_]/gu, "\\$&"),
    mode: "insensitive" as const,
  };
}

export async function findProfileForApi({
  where,
  prisma,
}: {
  where: Prisma.ProfileWhereInput;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.profile.findFirst({
    where: where,
    select: {
      userId: true,
      displayName: true,
      iconFileId: true,
      userName: true,
      bio: true,
    },
  });
}

export async function findUserIdByUserName({
  name,
  prisma,
}: {
  name: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.profile.findFirst({
    where: {
      userName: profileUserNameFilter(name),
    },
    select: {
      userId: true,
    },
  });
}

export async function findProfileForDiscover({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? await getDb();
  return await db.profile.findFirst({
    where: {
      userId: userId,
    },
    select: {
      userName: true,
      displayName: true,
      bio: true,
      iconFileId: true,
    },
  });
}

export async function getProfileByUserId(
  userId: string,
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? await getDb();
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
  const db = prisma || await getDb();
  return await db.profile.findFirst({
    where: {
      userName: profileUserNameFilter(userName),
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
  const db = prisma ?? await getDb();
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
  const db = prisma ?? await getDb();
  const taken = await db.profile.findFirst({
    where: {
      userName: profileUserNameFilter(userName),
      userId: { not: userId },
    },
    select: { userId: true },
  });
  if (taken) throw new ProfileUserNameTakenError();
  try {
    return await db.profile.upsert({
      where: { userId },
      update: { displayName, userName, bio },
      create: { userId, displayName, userName, bio },
    });
  } catch (error) {
    // The unique lower(userName) index settles concurrent claims. The upsert
    // targets the userId primary key, so a name conflict cannot replace its owner.
    if (isUniqueConstraintViolation(error)) throw new ProfileUserNameTakenError();
    throw error;
  }
}

export async function getSocialProviders(
  providers: string[],
  prisma?: PrismaTransaction,
) {
  const db = prisma ?? await getDb();
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
  const db = prisma ?? await getDb();
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
  const db = prisma ?? await getDb();
  return await db.socialProfile.deleteMany({
    where: {
      userId,
      providerId,
    },
  });
}
