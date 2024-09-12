import NextAuth from "next-auth"
import { PrismaAdapter } from "@auth/prisma-adapter"
import { prisma } from "@/prisma"
import Google from "next-auth/providers/google";
import Nodemailer from "@auth/core/providers/nodemailer";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [
    Google,
    Nodemailer({
      // dmarc
      from: process.env.EMAIL_FROM,
      server: {
        host: process.env.EMAIL_SERVER_HOST,
        port: process.env.EMAIL_SERVER_PORT,
        secure: false,
        requireTLS: true,
        auth: {
          user: process.env.EMAIL_SERVER_USER,
          pass: process.env.EMAIL_SERVER_PASSWORD,
        },
      }
    }),
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
  }
})