import NextAuth from "next-auth"
import { PrismaAdapter } from "@auth/prisma-adapter"
import { prisma } from "@/prisma"
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import Nodemailer from "@auth/core/providers/nodemailer";
import Passkey from "@auth/core/providers/passkey";
import { options as nodemailerOptions } from "./nodemailer";
import Credentials from "@auth/core/providers/credentials";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [
    Google,
    GitHub,
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    Nodemailer(nodemailerOptions) as any,
    // サーバー内部で使う
    //  - src/app/(manage-account)/account/manage/email/actions.ts
    Credentials({
      credentials: {
        userId: {},
        secret: {}
      },
      async authorize(credentials) {
        const user = await prisma.user.findFirst({
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
    Passkey
  ],
  events: {
    async createUser(message) {
      let userName = message.user.email?.split("@")[0];
      if (!userName || !message.user.id) return;
      const original = userName;

      let exists = await prisma.profile.findFirst({
        where: {
          userName: original
        }
      });
      for (let i = 1; exists; i++) {
        userName = `${original}${i}`;
        exists = await prisma.profile.findFirst({
          where: {
            userName: userName
          }
        });
      }

      await prisma.profile.create({
        data: {
          userId: message.user.id,
          displayName: message.user.name || userName,
          userName: userName,
        }
      });
    },
    signIn: async (message) => {
      if (message.account?.provider === "passkey") {
        await prisma.authenticator.update({
          where: {
            credentialID: message.account.providerAccountId
          },
          data: {
            usedAt: new Date(Date.now())
          }
        });
      }
    }
  },
  callbacks: {
    session: async ({session, user}) => {
      // user.nameをprofile.displayNameにする
      const profile = await prisma.profile.findFirst({
        where: {
          userId: user.id
        },
        select: {
          displayName: true
        }
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
  }
})