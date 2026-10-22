import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enforceOAuthEmailOwnership,
  oauthEmailOwnershipGate,
} from "@beutl/next/oauth-email-guard";

const dbMocks = vi.hoisted(() => ({
  // revokeAllUserSessions({ userId, ... }) の戻り値を持つ。
  revokeAllUserSessions: vi.fn(),
  // getDb() → db.user.findUnique({ where: { id }, select: { email: true } })。
  findUnique: vi.fn(),
}));

vi.mock("@beutl/db", () => ({
  getDb: () => Promise.resolve({ user: { findUnique: dbMocks.findUnique } }),
  revokeAllUserSessions: dbMocks.revokeAllUserSessions,
}));

// better-auth の user.validateUserInfo に渡るデータの構造 (代表値) を
// 再現するヘルパー。GitHub provider が userInfo.emailVerified に
// emails[].verified を写像すること (GitHub 未検証メール → false)、
// linking 経路では既存ユーザーの id が埋め込まれることに倣う。
function gateInput({
  providerId = "github",
  email,
  emailVerified,
  action,
}: {
  providerId?: string;
  email?: string;
  emailVerified?: unknown;
  action: "create-user" | "link-account" | "sign-in";
}) {
  return {
    user: {
      email: email ?? "victim@example.com",
      emailVerified,
      ...(action === "create-user" ? {} : { id: "user_123" }),
    },
    source: {
      action,
      method: "oauth",
      oauth: { providerId },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("oauthEmailOwnershipGate", () => {
  it.each(["create-user", "link-account", "sign-in"] as const)(
    "rejects an unverified GitHub email on %s",
    (action) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      try {
        const result = oauthEmailOwnershipGate(gateInput({ action, emailVerified: false }));
        expect(result?.error).toBe("githubEmailNotVerified");
        expect(result?.errorDescription).toContain("not verified");
        expect(consoleError).toHaveBeenCalledOnce();
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  it("fails closed when the GitHub profile does not claim emailVerified at all", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        oauthEmailOwnershipGate(gateInput({ action: "create-user", emailVerified: undefined })),
      ).toMatchObject({ error: "githubEmailNotVerified" });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("lets GitHub sign in when the email is verified on GitHub", () => {
    expect(
      oauthEmailOwnershipGate(gateInput({ action: "sign-in", emailVerified: true })),
    ).toBeUndefined();
  });

  it("does not police providers other than github", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Google の id_token は email_verified を署名付きで運べるため偽装不能。
      expect(
        oauthEmailOwnershipGate(
          gateInput({ providerId: "google", action: "link-account", emailVerified: true }),
        ),
      ).toBeUndefined();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("ignores non-OAuth provisioning sources", () => {
    expect(
      oauthEmailOwnershipGate({
        user: { emailVerified: false },
        source: { action: "create-user", method: "magic-link" },
      }),
    ).toBeUndefined();
  });
});

// better-auth に差し込む実装 (enforceOAuthEmailOwnership) の仕様。
// mock は各テストの beforeEach で初期化し、console.error は吐かせない。
beforeEach(() => {
  dbMocks.revokeAllUserSessions.mockReset().mockResolvedValue({
    sessions: 1,
    refreshTokenFamilies: 0,
  });
  dbMocks.findUnique.mockReset().mockResolvedValue({ email: "victim@example.com" });
});

describe("enforceOAuthEmailOwnership", () => {
  it("revokes carried-over sessions when a sign-in reuses an unsafe GitHub link", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await enforceOAuthEmailOwnership(
        gateInput({ action: "sign-in", emailVerified: false }),
      );

      expect(result?.error).toBe("githubEmailNotVerified");
      expect(dbMocks.revokeAllUserSessions).toHaveBeenCalledTimes(1);
      expect(dbMocks.revokeAllUserSessions).toHaveBeenCalledWith({ userId: "user_123" });
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not revoke sessions for link-account or sign-up rejections", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // ダッシュボードでログイン中のオーナーを追い出さない。
      await enforceOAuthEmailOwnership(
        gateInput({ action: "link-account", emailVerified: false }),
      );
      // 新規サインアップはユーザー行がまだない。
      await enforceOAuthEmailOwnership(
        gateInput({ action: "create-user", emailVerified: false }),
      );

      expect(dbMocks.revokeAllUserSessions).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("accepts a verified GitHub sign-in when the email matches the account", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // email の大小文字の差は無視する (GitHub 側の大文字小文字も信用しない)。
      const result = await enforceOAuthEmailOwnership(
        gateInput({ action: "sign-in", email: "Victim@Example.com", emailVerified: true }),
      );

      expect(result).toBeUndefined();
      expect(dbMocks.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "user_123" } }),
      );
      expect(dbMocks.revokeAllUserSessions).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects a verified GitHub sign-in whose email is not the account email", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 旧設定の implicit link が GitHub 上で別の検証済みメールを名乗って
      // いるケース。sign-in を拒否するが、正規のメール変更でも到達する
      // 状態なのでセッション失効は行わない。
      const result = await enforceOAuthEmailOwnership(
        gateInput({ action: "sign-in", email: "attacker@example.com", emailVerified: true }),
      );

      expect(result?.error).toBe("githubEmailMismatch");
      expect(dbMocks.revokeAllUserSessions).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fails closed when the account email cannot be read", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      dbMocks.findUnique.mockRejectedValueOnce(new Error("db down"));
      const result = await enforceOAuthEmailOwnership(
        gateInput({ action: "sign-in", email: "victim@example.com", emailVerified: true }),
      );

      expect(result?.error).toBe("githubEmailLookupUnavailable");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("treats a missing local user row as a mismatch", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      dbMocks.findUnique.mockResolvedValueOnce(undefined);
      const result = await enforceOAuthEmailOwnership(
        gateInput({ action: "sign-in", email: "victim@example.com", emailVerified: true }),
      );

      expect(result?.error).toBe("githubEmailMismatch");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("still rejects the sign-in when the session revocation fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      dbMocks.revokeAllUserSessions.mockRejectedValueOnce(new Error("db down"));
      const result = await enforceOAuthEmailOwnership(
        gateInput({ action: "sign-in", emailVerified: false }),
      );

      expect(result?.error).toBe("githubEmailNotVerified");
    } finally {
      consoleError.mockRestore();
    }
  });
});

// 既存の許可リスト (trustedProviders) が緩め直されて github に戻る異常を、
// バグではなくリグレッションとして検知するための静的な不変量。実行環境に
// OAuth シークレットがなくても評価できるよう、設定ソースを直接検査する。
const configFiles = [
  "../../apps/web/src/lib/better-auth.ts",
  "../../apps/admin/src/lib/better-auth.ts",
] as const;

describe.each(configFiles)("better-auth config %s", (configPath) => {
  it("never treats GitHub as an implicitly linkable provider", async () => {
    const source = await readFile(new URL(configPath, import.meta.url), "utf8");
    expect(source).toContain('trustedProviders: ["google"]');
    expect(source).not.toContain('trustedProviders: ["google", "github"]');
  });

  it("wires enforceOAuthEmailOwnership on user.validateUserInfo", async () => {
    const source = await readFile(new URL(configPath, import.meta.url), "utf8");
    expect(source).toContain("validateUserInfo: enforceOAuthEmailOwnership");
  });
});
