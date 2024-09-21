import type { NodemailerUserConfig } from "@auth/core/providers/nodemailer";

export const options: NodemailerUserConfig = {
  // dmarc
  from: process.env.EMAIL_FROM,
  server: {
    host: process.env.EMAIL_SERVER_HOST,
    port: Number.parseInt(process.env.EMAIL_SERVER_PORT as string),
    secure: false,
    requireTLS: true,
    auth: {
      user: process.env.EMAIL_SERVER_USER,
      pass: process.env.EMAIL_SERVER_PASSWORD,
    },
  }
} satisfies NodemailerUserConfig;