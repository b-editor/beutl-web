type ApiKeyBase = { id: string; name: string; hint: string; createdAt: string };

export type ApiKeySummary = ApiKeyBase & (
  | { kind: "nuget"; scope: "read" | "push"; expiresAt: string }
  | { kind: "repository"; scope: "read" | "write"; repositoryId: string; repositoryName: string; lastUsedAt: string | null }
);

export type ApiKeySettings =
  | { kind: "nuget"; name: string; scope: "read" | "push"; days: number }
  | { kind: "repository"; name: string; scope: "read" | "write"; repositoryId: string };

export type ApiKeyTarget =
  | { kind: "nuget"; id: string }
  | { kind: "repository"; id: string; repositoryId: string };

export type CreatedApiKey = { key: ApiKeySummary; secret: string; cloneUrl?: string };
export type AccountApiKeys = {
  keys: ApiKeySummary[];
  repositories: { id: string; name: string }[];
  gitAvailable: boolean;
};
