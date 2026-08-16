// beutl-web-api: デスクトップアプリ向け API 専用 Cloudflare Worker。
// 同一ドメイン・パス分割 (beutl.beditor.net/api/v{1,2,3}/*) で受ける。
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { setDbProvider } from "@beutl/db";
import { api } from "@beutl/api";
import {
  reconcileAiJobs,
  setR2BucketProvider,
  type R2BucketLike,
} from "@beutl/api";
import { reconcileDeletedAccountRemoteJobs } from "./ai/remote-job-cleanup";
import { reconcileBillingRefunds } from "./ai/billing-refunds";
import { reconcileTopUpRefunds } from "./ai/top-up-refunds";

export interface Env {
  BEUTL_DATABASE_HYPERDRIVE: {
    connectionString: string;
  };
  // vars (wrangler.jsonc) と secrets (wrangler secret put) の文字列バインディング。
  // workerd はこれらを process.env に自動投入しないため、fetch 冒頭でコピーする。
  // ここに列挙したキーは「vars/secrets に設定されていれば」コピーされる。
  // 未設定のキー (例: BEUTL_LATEST_VERSION) は undefined のまま (Web 側と同挙動)。
  JWT_SECRET?: string;
  JWT_ISSUER?: string;
  JWT_AUDIENCE?: string;
  JWT_EXPIRATION_MINUTES?: string;
  JWT_REFRESH_TOKEN_EXPIRATION_DAYS?: string;
  PUBLIC_ORIGIN?: string;
  IPINFO_TOKEN?: string;
  BEUTL_LATEST_VERSION?: string;
  BEUTL_REQUIRED_VERSION?: string;
  ADMIN_USER_IDS?: string;
  BEUTL_R2_BUCKET?: R2BucketLike;
  STRIPE_SECRET_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_WEBHOOK_SECRET?: string;
  OPENROUTER_REQUEST_TIMEOUT_MS?: string;
  OPENROUTER_IMAGE_MODEL?: string;
  OPENROUTER_IMAGE_EDIT_MODEL_REMOVE_BACKGROUND?: string;
  OPENROUTER_IMAGE_EDIT_MODEL_UPSCALE?: string;
  OPENROUTER_IMAGE_EDIT_MODEL_RESTYLE?: string;
  OPENROUTER_IMAGE_EDIT_MODEL_REMOVE_OBJECT?: string;
  OPENROUTER_IMAGE_EDIT_MODEL_OUTPAINT?: string;
  OPENROUTER_STT_MODEL?: string;
  OPENROUTER_TRANSLATION_MODEL?: string;
  OPENROUTER_VIDEO_MODEL?: string;
}

type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

type ScheduledControllerLike = {
  scheduledTime: number;
};

// Hyperdrive の per-request 接続モデル (maxUses:1) に合わせ、毎リクエスト新規生成する。
// モジュールスコープで PrismaClient を保持しない (isolate 跨ぎのリーク防止)。
const createProvider = (env: Env) => {
  return async () => {
    const connectionString = env.BEUTL_DATABASE_HYPERDRIVE.connectionString;
    if (!connectionString) {
      throw new Error("BEUTL_DATABASE_HYPERDRIVE binding not found");
    }
    const adapter = new PrismaPg({ connectionString, maxUses: 1 });
    return new PrismaClient({ adapter });
  };
};

function configureRuntime(env: Env): void {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      process.env[key] = value;
    }
  }
  setDbProvider(createProvider(env));
  if (env.BEUTL_R2_BUCKET) {
    setR2BucketProvider(() => env.BEUTL_R2_BUCKET as R2BucketLike);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // workerd は vars/secrets を process.env に自動投入しない。
    // OpenNext (Web Worker) の populateProcessEnv と同じく文字列バインディングを
    // process.env へコピーする。v1/account (JWT) や v1/app (バージョン) は
    // process.env を直接参照するため、これがないと独立 Worker で undefined になる。
    configureRuntime(env);
    return api.fetch(request, env);
  },
  async scheduled(
    controller: ScheduledControllerLike,
    env: Env,
    context: ExecutionContextLike,
  ): Promise<void> {
    configureRuntime(env);
    const scheduledAt = new Date(controller.scheduledTime);
    context.waitUntil(
      Promise.all([
        reconcileAiJobs(scheduledAt),
        reconcileDeletedAccountRemoteJobs(scheduledAt),
        reconcileTopUpRefunds(scheduledAt, env.STRIPE_SECRET_KEY),
        reconcileBillingRefunds(scheduledAt, env.STRIPE_SECRET_KEY),
      ]).then(([jobs, deletedAccountJobs, topUpRefunds, billingRefunds]) => {
        console.log("Scheduled reconciliation completed", {
          jobs,
          deletedAccountJobs,
          topUpRefunds,
          billingRefunds,
        });
        if (topUpRefunds.interventionRequired > 0) {
          console.error("Top-up refunds require manual intervention", {
            count: topUpRefunds.interventionRequired,
          });
        }
        if (billingRefunds.interventionRequired > 0) {
          console.error("Billing refunds require manual intervention", {
            count: billingRefunds.interventionRequired,
          });
        }
      }),
    );
  },
};
