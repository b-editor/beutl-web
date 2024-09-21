import NextAuth from "next-auth"
import { PrismaAdapter } from "@auth/prisma-adapter"
import { prisma } from "@/prisma"
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import Nodemailer from "@auth/core/providers/nodemailer";
import { options as nodemailerOptions } from "./nodemailer";
import Credentials from "@auth/core/providers/credentials";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [
    Google,
    GitHub,
    Nodemailer(nodemailerOptions),
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
    })
  ],
  events: {
    async createUser(message) {
      const userName = message.user.email?.split("@")[0];
      if (!userName || !message.user.id) return;
      await prisma.profile.create({
        data: {
          userId: message.user.id,
          displayName: message.user.name || userName,
          userName: userName,
        }
      });
    }
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
  }
})