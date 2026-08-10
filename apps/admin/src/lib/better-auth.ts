import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { passkey } from "@better-auth/passkey";
import { magicLink } from "better-auth/plugins";
import { getDb } from "@beutl/db";
import { addAuditLog, auditLogActions } from "@beutl/next/audit-log";
import { onUserCreated } from "@beutl/next/auth-hooks";
import { sendEmail } from "@beutl/email";
import type { Session, User } from "better-auth";

export type BetterAuthSession = Session;
export type BetterAuthUser = User;

let authInstance: Awaited<ReturnType<typeof createAuthWithPrisma>> | null = null;

async function createAuthWithPrisma() {
  const prisma = await getDb();
  const adminURL = process.env.BETTER_AUTH_URL || "http://localhost:3001";
  return betterAuth({
    database: prismaAdapter(prisma, {
      provider: "postgresql",
    }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: adminURL,
    // 公開サイトのオリジンは含めない。セッション共有は crossSubDomainCookies が
    // 行うため trustedOrigins には不要で、加えるとクッキーが同一サイト送信される
    // 分だけ管理 Worker のオリジン検査が公開サイト側へ開いてしまう。
    trustedOrigins: [adminURL],
    emailAndPassword: {
      enabled: false,
    },
    socialProviders: {
      google: {
        clientId: process.env.AUTH_GOOGLE_ID as string,
        clientSecret: process.env.AUTH_GOOGLE_SECRET as string,
        // disableImplicitSignUp だけだと requestSignUp: true を送るリクエストで
        // 新規ユーザーを作れてしまう (better-auth の callback は
        // `disableImplicitSignUp && !requestSignUp || options.disableSignUp`)。
        // 管理画面はサインアップの導線ではないので両方立てる。
        disableImplicitSignUp: true,
        disableSignUp: true,
      },
      github: {
        clientId: process.env.AUTH_GITHUB_ID as string,
        clientSecret: process.env.AUTH_GITHUB_SECRET as string,
        disableImplicitSignUp: true,
        disableSignUp: true,
      },
    },
    plugins: [
      passkey({
        rpID: process.env.BETTER_AUTH_RP_ID || "localhost",
        rpName: "Beutl Admin",
        origin: adminURL,
      }),
      magicLink({
        disableSignUp: true,
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
      // クッキー名の既定は "better-auth.<name>" で web と同一。Domain 共有を有効に
      // すると両 Worker のクッキーが同名・同ドメイン・同パスで衝突するため、
      // 管理 Worker 側は接頭辞を分ける。共有したいのはセッションだけなので
      // session_token だけ web と同じ名前に固定する。
      // これを分けないと、OAuth の state クッキー (__Secure-better-auth.state) を
      // 両サイトが上書きし合い、先に始めたサインインが
      // state_security_mismatch で失敗する。
      cookiePrefix: "beutl-admin",
      cookies: {
        session_token: { name: "better-auth.session_token" },
      },
      // BETTER_AUTH_COOKIE_DOMAIN を設定したときだけ Domain 付きのセッションクッキーを
      // 発行し、既存 Web (beutl.beditor.net) と共有する。
      // 値には共有に必要な最小のドメインを指定する (本番では beutl.beditor.net)。
      // admin.beutl.beditor.net はその配下なのでこれで共有できる。
      // ルートドメイン (beditor.net) を指定すると配下の無関係なホストにも
      // セッションクッキーが送信される。
      // 未設定なら better-auth の既定どおり host-only クッキーのままで、
      // Web とは共有されない。ローカル開発 (localhost) や
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
      // サインアップ導線は塞いでいるが、better-auth には requestSignUp や
      // idToken 経由でユーザーが作られうる経路が残る。web と同じフックを共有し、
      // 管理 Worker 経由で作られても Profile と監査ログが必ず付くようにする。
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

export async function getAuth() {
  if (!authInstance) {
    authInstance = await createAuthWithPrisma();
  }
  return authInstance;
}
