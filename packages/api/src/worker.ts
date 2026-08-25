// beutl-web-api: デスクトップアプリ向け API 専用 Cloudflare Worker。
// 同一ドメイン・パス分割 (beutl.beditor.net/api/v{1,2,3}/*) で受ける。
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { setDbProvider } from "@beutl/db";
import { boundedBody, MAX_API_REQUEST_BODY_BYTES } from "@beutl/core";
import { api } from "@beutl/api";
import {
  reconcileAiJobs,
  setR2BucketProvider,
  type R2BucketLike,
} from "@beutl/api";
import { reconcileDeletedAccountRemoteJobs } from "./ai/remote-job-cleanup";
import { reconcileBillingRefunds } from "./ai/billing-refunds";
import { reconcileTopUpRefunds } from "./ai/top-up-refunds";
import { abandonStaleStorageUploads } from "./storage-uploads";

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

// 本文を持たないのは GET と HEAD だけ。ほかは、たとえ普通は本文を持たない
// メソッドでも、付いていれば下流が読む。
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

function withBoundedBody(request: Request): Request | null {
  if (BODYLESS_METHODS.has(request.method) || !request.body) return request;

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length > MAX_API_REQUEST_BODY_BYTES) {
      return null;
    }
  }

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: boundedBody(request.body, MAX_API_REQUEST_BODY_BYTES),
    signal: request.signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 本文の大きさを、中へ渡す前に。v1 の入口は認証より先に JSON を丸ごと
    // 解釈するので、誰でも——名乗らずとも——大きな本文を読ませられる。
    // 長さを名乗るならそれで断り、名乗らないなら数えながら通す。
    const bounded = withBoundedBody(request);
    if (bounded === null) {
      return new Response(null, { status: 413 });
    }

    // workerd は vars/secrets を process.env に自動投入しない。
    // OpenNext (Web Worker) の populateProcessEnv と同じく文字列バインディングを
    // process.env へコピーする。v1/account (JWT) や v1/app (バージョン) は
    // process.env を直接参照するため、これがないと独立 Worker で undefined になる。
    configureRuntime(env);
    return api.fetch(bounded, env);
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
        abandonStaleStorageUploads(scheduledAt),
        reconcileAiJobs(scheduledAt),
        reconcileDeletedAccountRemoteJobs(scheduledAt),
        reconcileTopUpRefunds(scheduledAt, env.STRIPE_SECRET_KEY),
        reconcileBillingRefunds(scheduledAt, env.STRIPE_SECRET_KEY),
      ]).then(([
        storageUploads,
        jobs,
        deletedAccountJobs,
        topUpRefunds,
        billingRefunds,
      ]) => {
        console.log("Scheduled reconciliation completed", {
          storageUploads,
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
