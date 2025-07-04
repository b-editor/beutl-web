import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/prisma";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import Resend from "@auth/core/providers/resend";
import Passkey from "@auth/core/providers/passkey";
import { options as resendOptions } from "./resend";
import Credentials from "@auth/core/providers/credentials";
import { updateAuthenticatorUsedAt } from "./lib/db/authenticator";
import { addAuditLog, auditLogActions } from "./lib/audit-log";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [
    Google,
    GitHub,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Resend(resendOptions) as any,
    // サーバー内部で使う
    //  - src/app/(manage-account)/account/manage/email/actions.ts
    Credentials({
      credentials: {
        userId: {},
        secret: {},
      },
      async authorize(credentials) {
        const db = prisma;
        const user = await db.user.findFirst({
          where: {
            id: credentials.userId as string,
          },
        });
        if (!user) {
          return null;
        }
        if (credentials.secret !== process.env.AUTH_SECRET) {
          return null;
        }
        return user;
      },
    }),
    Passkey,
  ],
  events: {
    async createUser(message) {
      let userName = message.user.email?.split("@")[0];
      if (!userName || !message.user.id) return;
      const original = userName;

      const db = prisma;
      let exists = await db.profile.findFirst({
        where: {
          userName: original,
        },
      });
      for (let i = 1; exists; i++) {
        userName = `${original}${i}`;
        exists = await db.profile.findFirst({
          where: {
            userName: userName,
          },
        });
      }

      await db.profile.create({
        data: {
          userId: message.user.id,
          displayName: message.user.name || userName,
          userName: userName,
        },
      });
      await addAuditLog({
        // biome-ignore lint/style/noNonNullAssertion: <explanation>
        userId: message.user.id!,
        action: auditLogActions.authjs.createUser,
        details: `userName: ${userName}, email: ${message.user.email}`,
      });
    },
    signIn: async (message) => {
      if (message.account?.provider === "passkey") {
        await updateAuthenticatorUsedAt({
          credentialID: message.account.providerAccountId,
          usedAt: new Date(Date.now()),
        });
      }
      await addAuditLog({
        // biome-ignore lint/style/noNonNullAssertion: <explanation>
        userId: message.user.id!,
        action: auditLogActions.authjs.signIn,
        details: `provider: ${message.account?.provider}`,
      });
    },
    signOut: async (message) => {
      let userId = undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((message as any).session?.userId) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        userId = (message as any).session.userId;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } else if ((message as any).jwt?.userId) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        userId = (message as any).jwt.userId;
      }

      if (userId) {
        await addAuditLog({
          userId: userId,
          action: auditLogActions.authjs.signOut,
          details: "",
        });
      }
    },
    linkAccount: async (message) => {
      await addAuditLog({
        // biome-ignore lint/style/noNonNullAssertion: <explanation>
        userId: message.user.id!,
        action: auditLogActions.authjs.linkAccount,
        details: `provider: ${message.account.provider}`,
      });
    },
  },
  callbacks: {
    session: async ({ session, user }) => {
      // user.nameをprofile.displayNameにする
      const db = prisma;
      const profile = await db.profile.findFirst({
        where: {
          userId: user.id,
        },
        select: {
          displayName: true,
        },
      });
      if (profile) {
        session.user.name = profile.displayName;
      }
      return session;
    },
  },
  pages: {
    signIn: "/account/sign-in",
    signOut: "/account/sign-out",
    // error: "/account/error",
    verifyRequest: "/account/verify-request",
  },
  theme: {
    logo: "/img/logo_dark.svg",
    colorScheme: "dark",
    brandColor: "#3F34F0",
  },
  experimental: {
    enableWebAuthn: true,
  },
});
