import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { passkey } from "@better-auth/passkey";
import { customSession, magicLink } from "better-auth/plugins";
import { findProfileForDiscover, getDb } from "@beutl/db";
import { profileDisplayName } from "@beutl/core";
import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import { onUserCreated } from "@beutl/next/auth-hooks";
import { authEmailRateLimitHook } from "@beutl/next/auth-email-rate-limit";
import { enforceOAuthEmailOwnership } from "@beutl/next/oauth-email-guard";

import { sendMagicLinkEmail } from "@beutl/next/magic-link-email";
import type { Session, User } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { cache } from "react";

// Export types for use elsewhere
export type BetterAuthSession = Session;
export type BetterAuthUser = User;

// Create the auth instance with Prisma adapter
async function createAuthWithPrisma() {
  const prisma = await getDb();
  return betterAuth({
    database: prismaAdapter(prisma, {
      provider: "postgresql",
    }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
    trustedOrigins: [
      process.env.BETTER_AUTH_URL || "http://localhost:3000",
    ],
    emailAndPassword: {
      enabled: false,
    },
    socialProviders: {
      google: {
        clientId: process.env.AUTH_GOOGLE_ID as string,
        clientSecret: process.env.AUTH_GOOGLE_SECRET as string,
      },
      github: {
        clientId: process.env.AUTH_GITHUB_ID as string,
        clientSecret: process.env.AUTH_GITHUB_SECRET as string,
      },
    },
    plugins: [
      passkey({
        rpID: process.env.BETTER_AUTH_RP_ID || "localhost",
        rpName: "Beutl",
        origin: process.env.BETTER_AUTH_URL || "http://localhost:3000",
      }),
      magicLink({
        sendMagicLink: sendMagicLinkEmail,
      }),
      // Apply the saved identity after reading the auth session, including a
      // cookie-cache hit. Provider fields never replace a profile setting.
      customSession(async ({ user, session }) => {
        const profile = await findProfileForDiscover({ userId: user.id, prisma });
        return {
          session,
          user: {
            ...user,
            name: profileDisplayName(profile) ?? "",
            image: profile?.iconFileId
              ? `/api/contents/${encodeURIComponent(profile.iconFileId)}`
              : null,
          },
        };
      }),
      nextCookies(),
    ],
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5,
      },
    },
    user: {
      // GitHub プロバイダの emailVerified を検査するゲート。GitHub は未検証の
      // メールでも profile.email になり得るため、サインアップ・紐付け・再
      // サインインの 3 経路すべてで未検証の GitHub email を拒否する。sign-in
      // 拒否時には旧設定で発行されたセッションも失効させる
      // (詳細は packages/next/src/oauth-email-guard.ts)。
      validateUserInfo: enforceOAuthEmailOwnership,
      additionalFields: {
        createdAt: {
          type: "date",
          required: false,
        },
        updatedAt: {
          type: "date",
          required: false,
        },
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        // GitHub は任意のメールアドレスを未検証のままアカウントに追加できるため、
        // プロフィール email の所有証明として email を信じられない。implicit
        // linking の trustedProviders に入れると、被害者のメールアドレスを
        // 攻撃者の GitHub に追加して OAuth サインインするだけで被害者アカウントに
        // 紐付けられ、乗っ取りに至る。GitHub の未検証メールでのサインアップ/
        // 紐付け/再サインインは user.validateUserInfo の enforceOAuthEmailOwnership
        // が拒否する (詳細は packages/next/src/oauth-email-guard.ts)。
        trustedProviders: ["google"],
      },
    },
    hooks: { before: authEmailRateLimitHook },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // BETTER_AUTH_COOKIE_DOMAIN を設定したときだけ Domain 付きのセッションクッキーを
      // 発行し、管理画面 (apps/admin, admin.beutl.beditor.net) と共有する。
      // 値には共有に必要な最小のドメインを指定する (本番では beutl.beditor.net)。
      // ルートドメイン (beditor.net) を指定すると配下の無関係なホストにも
      // セッションクッキーが送信される。
      // 未設定なら better-auth の既定どおり host-only クッキーのままで、
      // サブドメイン間では共有されない。ローカル開発 (localhost) や
      // サブドメイン間共有が不要な環境では設定しないこと。
      //
      // 注意: host-only だった既存クッキーに Domain 属性を付けると、ブラウザ上は
      // 別エントリの新規クッキーになる。同名の 2 つが併送され、どちらが読まれるかは
      // パスと生成時刻に依存するため、切り替え時は既存クッキーの明示的な失効が必要。
      ...(process.env.BETTER_AUTH_COOKIE_DOMAIN
        ? {
            crossSubDomainCookies: {
              enabled: true,
              domain: process.env.BETTER_AUTH_COOKIE_DOMAIN,
            },
          }
        : {}),
    },
    databaseHooks: {
      user: {
        create: {
          after: onUserCreated,
        },
      },
      session: {
        create: {
          after: async (session) => {
            await addAuditLog({
              userId: session.userId,
              action: auditLogActions.authjs.signIn,
              details: "",
            });
          },
        },
        delete: {
          after: async (session) => {
            await addAuditLog({
              userId: session.userId,
              action: auditLogActions.authjs.signOut,
              details: "",
            });
          },
        },
      },
      account: {
        create: {
          after: async (account) => {
            await addAuditLog({
              userId: account.userId,
              action: auditLogActions.authjs.linkAccount,
              details: `provider: ${account.providerId}`,
            });
          },
        },
      },
    },
  });
}

// Better Auth closes over its Prisma adapter. React shares the instance within
// one Server Component render without retaining it in the Worker module scope.
export const getAuth = cache(createAuthWithPrisma);

// Export an async auth handler for route.ts
export const auth = {
  handler: async (request: Request) => {
    const instance = await getAuth();
    return instance.handler(request);
  },
  api: {
    getSession: async (options: { headers: Headers; query?: { disableCookieCache?: boolean } }) => {
      const instance = await getAuth();
      return instance.api.getSession(options);
    },
  },
};
