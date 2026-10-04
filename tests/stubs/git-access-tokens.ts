import { vi } from "vitest";
import { generateGitAccessToken, hashGitAccessToken } from "../../packages/api/src/git/tokens";

export type GitAccessTokenRow = Awaited<ReturnType<typeof gitAccessTokenFixture>>["row"];

/** A stored access token row and its one-time secret. */
export async function gitAccessTokenFixture({ repoId, ownerId = "owner", scope = "write" as "read" | "write",
  revokedAt = null as Date | null, repository = { ownerId, deletedAt: null as Date | null } }: {
  repoId: string; ownerId?: string; scope?: "read" | "write"; revokedAt?: Date | null;
  repository?: { ownerId: string | null; deletedAt: Date | null };
}) {
  const token = generateGitAccessToken();
  return {
    token,
    row: {
      id: crypto.randomUUID(), repoId, ownerId, name: `${scope} token`, scope,
      tokenHash: await hashGitAccessToken(token), hint: token.slice(-4),
      createdAt: new Date("2026-10-04T00:00:00Z"), lastUsedAt: null as Date | null, revokedAt, repository,
    },
  };
}

/** A Prisma gitAccessToken delegate over fixed rows, looked up by token hash. */
export function gitAccessTokenDelegate(rows: GitAccessTokenRow[]) {
  return {
    findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) =>
      rows.find((row) => row.tokenHash === where.tokenHash) ?? null),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
}

/** Git sends `https://USER:TOKEN@host` as Basic credentials. */
export const basicCredential = (token: string, user = "git") => `Basic ${btoa(`${user}:${token}`)}`;
