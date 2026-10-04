export const GIT_REPOSITORY_LIMIT = 20;
export const GIT_REPOSITORY_NAME_MAX_LENGTH = 80;

export function isValidGitRepositoryName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= GIT_REPOSITORY_NAME_MAX_LENGTH && !/[\p{Cc}/\\]/u.test(value);
}

export function isGitRepositoryId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value) &&
    value !== "00000000-0000-0000-0000-000000000000";
}

export type GitRepositorySummary = {
  id: string;
  name: string;
  url: string;
  createdAt: string;
  updatedAt: string;
};

export type GitRepositoryToken = { token: string; expiresAt: string };
