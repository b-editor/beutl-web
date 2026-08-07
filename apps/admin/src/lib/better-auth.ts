import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { passkey } from "@better-auth/passkey";
import { magicLink } from "better-auth/plugins";
import { getDb } from "@beutl/db";
import { addAuditLog, auditLogActions } from "./audit-log";
import { sendEmail } from "@/resend";
import type { Session, User } from "better-auth";

// Export types for use elsewhere
export type BetterAuthSession = Session;
export type BetterAuthUser = User;

let authInstance: Awaited<ReturnType<typeof createAuthWithPrisma>> | null = null;

async function createAuthWithPrisma() {
  const prisma = await getDb();
  const adminURL = process.env.BETTER_AUTH_URL || "http://localhost:3001";
  const webURL = process.env.BETTER_AUTH_WEB_URL || "http://localhost:3000";
  return betterAuth({
    database: prismaAdapter(prisma, {
      provider: "postgresql",
    }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: adminURL,
    trustedOrigins: [adminURL, webURL],
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
        rpName: "Beutl Admin",
        origin: adminURL,
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
    // 既存 Web (beutl.beditor.net) とセッションを共有する。
    // domain 未指定時は baseURL からルートドメインを自動導出するため、
    // ローカル開発 (localhost) ではクッキードメインを壊さない。
    crossSubDomainCookies: {
      enabled: true,
      ...(process.env.BETTER_AUTH_COOKIE_DOMAIN
        ? { domain: process.env.BETTER_AUTH_COOKIE_DOMAIN }
        : {}),
    },
    databaseHooks: {
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

// Export an async auth handler for route.ts
export const auth = {
  handler: async (request: Request) => {
    if (!authInstance) {
      authInstance = await createAuthWithPrisma();
    }
    return authInstance.handler(request);
  },
  api: {
    getSession: async (options: { headers: Headers }) => {
      if (!authInstance) {
        authInstance = await createAuthWithPrisma();
      }
      return authInstance.api.getSession(options);
    },
  },
};

// Export the auth instance getter for other uses
export async function getAuth() {
  if (!authInstance) {
    authInstance = await createAuthWithPrisma();
  }
  return authInstance;
}
