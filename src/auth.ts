import NextAuth from "next-auth"
import PostgresAdapter from "@auth/pg-adapter"
import { Pool } from "pg";
import Google from "next-auth/providers/google";
import Nodemailer from "@auth/core/providers/nodemailer";

const pool = new Pool({
  host: process.env.DATABASE_HOST,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: true
})

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PostgresAdapter(pool),
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
  pages: {
    signIn: "/account/sign-in",
    signOut: "/account/sign-out",
    // error: "/account/error",
    verifyRequest: "/account/verify-request",
    newUser: "/account/sign-up",
  },
  theme:{
    logo: "/img/logo_dark.svg",
    colorScheme: "dark",
    brandColor: "#3F34F0",
  }
})