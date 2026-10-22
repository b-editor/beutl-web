import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oauthEmailOwnershipGate } from "@beutl/next/oauth-email-guard";

// better-auth の user.validateUserInfo に渡るデータの構造 (代表値) を
// 再現するヘルパー。GitHub provider が userInfo.emailVerified に
// emails[].verified を写像すること (GitHub 未検証メール → false)、
// linking 経路では既存ユーザーの id が埋め込まれることに倣う。
function gateInput({
  providerId = "github",
  emailVerified,
  action,
}: {
  providerId?: string;
  emailVerified?: unknown;
  action: "create-user" | "link-account" | "sign-in";
}) {
  return {
    user: {
      email: "someone@example.com",
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

  it("wires the oauthEmailOwnershipGate on user.validateUserInfo", async () => {
    const source = await readFile(new URL(configPath, import.meta.url), "utf8");
    expect(source).toContain("validateUserInfo: oauthEmailOwnershipGate");
  });
});
