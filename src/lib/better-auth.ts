import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { passkey } from "@better-auth/passkey";
import { magicLink } from "better-auth/plugins";
import { getDbAsync } from "@/prisma";
import { addAuditLog, auditLogActions } from "./audit-log";
import { sendEmail } from "@/resend";
import type { Session, User } from "better-auth";
import { nextCookies } from "better-auth/next-js";

// Export types for use elsewhere
export type BetterAuthSession = Session;
export type BetterAuthUser = User;

// Create auth instance lazily but cache it
let authInstance: Awaited<ReturnType<typeof createAuthWithPrisma>> | null = null;

// Create the auth instance with Prisma adapter
async function createAuthWithPrisma() {
  const prisma = await getDbAsync();
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
      nextCookies()
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
    verification: {
      
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google", "github"],
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const db = await getDbAsync();
            let userName = user.email?.split("@")[0];
            if (!userName) return;

            const original = userName;
            let exists = await db.profile.findFirst({
              where: { userName: original },
            });
            for (let i = 1; exists; i++) {
              userName = `${original}${i}`;
              exists = await db.profile.findFirst({
                where: { userName },
              });
            }

            await db.profile.create({
              data: {
                userId: user.id,
                displayName: user.name || userName,
                userName,
              },
            });

            await addAuditLog({
              userId: user.id,
              action: auditLogActions.authjs.createUser,
              details: `userName: ${userName}, email: ${user.email}`,
            });
          },
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
    // pages: {
    //   signIn: "/account/sign-in",
    //   signOut: "/account/sign-out",
    //   verifyRequest: "/account/verify-request",
    //   error: "/account/error",
    // },
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
