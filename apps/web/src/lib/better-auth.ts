import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { passkey } from "@better-auth/passkey";
import { magicLink } from "better-auth/plugins";
import { getDb } from "@beutl/db";
import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import { onUserCreated } from "@beutl/next/auth-hooks";
import { sendEmail } from "@beutl/email";
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
        sendMagicLink: async ({ email, url }) => {
          const { host } = new URL(url);
          await sendEmail({
            to: email,
            subject: `Sign in to ${host}`,
            body: `
              <p>Click the link below to sign in:</p>
              <a href="${url}">Sign in</a>
            `,
          });
        },
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
        trustedProviders: ["google", "github"],
      },
    },
    advanced: {
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

// Better Auth closes over its Prisma adapter. React's server cache keeps the
// instance within one request, so no request-bound I/O survives in the Worker
// module scope.
export const getAuth = cache(createAuthWithPrisma);

// Export an async auth handler for route.ts
export const auth = {
  handler: async (request: Request) => {
    const instance = await getAuth();
    return instance.handler(request);
  },
  api: {
    getSession: async (options: { headers: Headers }) => {
      const instance = await getAuth();
      return instance.api.getSession(options);
    },
  },
};
