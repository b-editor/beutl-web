// beutl-web-api: デスクトップアプリ向け API 専用 Cloudflare Worker。
// 同一ドメイン・パス分割 (beutl.beditor.net/api/v{1,2,3}/*) で受ける。
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { setDbProvider } from "@beutl/db";
import {
  boundedBody,
  MAX_AI_TRANSLATION_JSON_REQUEST_BYTES,
  MAX_API_JSON_REQUEST_BYTES,
  MULTIPART_OVERHEAD_BYTES,
  STORAGE_UPLOAD_PART_BYTES,
} from "@beutl/core";
import { aiApiMultipartBodyLimit } from "./ai/upload-limits";
import { api } from "@beutl/api";
import {
  reconcileAiJobs,
  setR2BucketProvider,
  type R2BucketLike,
  reconcileStripeCustomerProvisioning,
} from "@beutl/api";
import { reconcileDeletedAccountRemoteJobs } from "./ai/remote-job-cleanup";
import { reconcileBillingRefunds } from "./ai/billing-refunds";
import { reconcileTopUpRefunds } from "./ai/top-up-refunds";
import { reconcilePackagePaymentRefunds } from "./ai/package-payment-refunds";
import { reconcileTopUpDuplicateRefunds } from "./ai/topup-duplicate-refunds";
import { reconcileStripeCheckoutCleanups } from "./ai/stripe-checkout-cleanups";
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

// Only GET and HEAD are bodyless. Other methods may carry a body that the
// downstream handler reads.
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
export const MAX_OPENROUTER_CALLBACK_BODY_BYTES = 64 * 1024;
const JSON_ROUTES = new Set([
  "/api/v1/account/createAuthUri",
  "/api/v1/account/refresh",
  "/api/v1/account/code2jwt",
  "/api/v3/account/library",
  "/api/v3/user/ai-availability",
  "/api/v3/ai/images",
  "/api/v3/ai/videos",
  "/api/v3/ai/translations",
]);
/**
 * Keep the outer Worker cap aligned with the parser used by each route. The
 * outer cap is a memory guard, while the endpoint parser remains the source
 * of the precise multipart error response.
 */
export function requestBodyLimitForWorker(
  pathname: string,
  contentType: string | null,
): number {
  const multipart = contentType?.toLowerCase().startsWith("multipart/form-data")
    === true;
  const aiLimit = aiApiMultipartBodyLimit(pathname);
  if (aiLimit !== null) {
    if (multipart) return aiLimit;
    if (contentType?.toLowerCase().startsWith("application/json") === true) {
      return MAX_API_JSON_REQUEST_BYTES;
    }
    return aiLimit;
  }
  if (JSON_ROUTES.has(pathname)) {
    if (pathname === "/api/v3/ai/translations") {
      return MAX_AI_TRANSLATION_JSON_REQUEST_BYTES;
    }
    return MAX_API_JSON_REQUEST_BYTES;
  }
  if (/^\/api\/v3\/ai\/videos\/[^/]+\/openrouter-callback$/u.test(pathname)) {
    return MAX_OPENROUTER_CALLBACK_BODY_BYTES;
  }
  // The standalone API does not expose the Web's internal upload routes, but
  // retaining this classifier keeps the shared route contract explicit if the
  // route is mounted here in a deployment.
  if (/^\/api\/internal\/storage\/uploads\/[^/]+\/parts\/\d+$/u.test(pathname)) {
    return STORAGE_UPLOAD_PART_BYTES + MULTIPART_OVERHEAD_BYTES;
  }
  if (contentType?.toLowerCase().startsWith("application/json") === true) {
    return MAX_API_JSON_REQUEST_BYTES;
  }
  // Unknown routes are not upload routes. Keep their guard conservative until
  // a concrete binary/multipart endpoint is added to the allowlist above.
  return MAX_API_JSON_REQUEST_BYTES;
}

function withBoundedBody(
  request: Request,
  onLimitExceeded: () => void,
): Request | null {
  if (BODYLESS_METHODS.has(request.method) || !request.body) return request;

  const limit = requestBodyLimitForWorker(
    new URL(request.url).pathname,
    request.headers.get("content-type"),
  );

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length > limit) {
      return null;
    }
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: boundedBody(request.body, limit, onLimitExceeded),
    signal: request.signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Bound the body before routing. Some v1 handlers parse JSON before auth,
    // so declared and streamed sizes must be rejected at the Worker boundary.
    let bodyLimitExceeded = false;
    const bounded = withBoundedBody(request, () => {
      bodyLimitExceeded = true;
    });
    if (bounded === null) {
      return new Response(null, { status: 413 });
    }

    // workerd は vars/secrets を process.env に自動投入しない。
    // OpenNext (Web Worker) の populateProcessEnv と同じく文字列バインディングを
    // process.env へコピーする。v1/account (JWT) や v1/app (バージョン) は
    // process.env を直接参照するため、これがないと独立 Worker で undefined になる。
    configureRuntime(env);
    try {
      const response = await api.fetch(bounded, env);
      // Hono's JSON parser can turn a stream error into a generic 400 before
      // the endpoint sees it. The outer stream marker still gives the Worker
      // an unambiguous 413 response for chunked bodies.
      return bodyLimitExceeded
        ? new Response(null, { status: 413 })
        : response;
    } catch (error) {
      if (bodyLimitExceeded) return new Response(null, { status: 413 });
      throw error;
    }
  },
  async scheduled(
    controller: ScheduledControllerLike,
    env: Env,
    context: ExecutionContextLike,
  ): Promise<void> {
    configureRuntime(env);
    const scheduledAt = new Date(controller.scheduledTime);
    // Duplicate top-up and package-payment refunds may be created by checkout
    // recovery. Let both refund workers finish before cleanup consumes their
    // durable resolution rows, while keeping unrelated reconcilers parallel.
    const topUpDuplicateRefunds = reconcileTopUpDuplicateRefunds(
      scheduledAt,
      env.STRIPE_SECRET_KEY,
    );
    const packagePaymentRefunds = reconcilePackagePaymentRefunds(
      scheduledAt,
      env.STRIPE_SECRET_KEY,
    );
    const stripeCheckoutCleanups = Promise.all([
      topUpDuplicateRefunds,
      packagePaymentRefunds,
    ]).then(() =>
      reconcileStripeCheckoutCleanups(scheduledAt, env.STRIPE_SECRET_KEY),
    );
    context.waitUntil(
      Promise.all([
        abandonStaleStorageUploads(scheduledAt),
        reconcileAiJobs(scheduledAt),
        reconcileDeletedAccountRemoteJobs(scheduledAt),
        reconcileTopUpRefunds(scheduledAt, env.STRIPE_SECRET_KEY),
        topUpDuplicateRefunds,
        packagePaymentRefunds,
        reconcileStripeCustomerProvisioning(scheduledAt, env.STRIPE_SECRET_KEY),
        stripeCheckoutCleanups,
        reconcileBillingRefunds(scheduledAt, env.STRIPE_SECRET_KEY),
      ]).then(([
        storageUploads,
        jobs,
        deletedAccountJobs,
        topUpRefunds,
        topUpDuplicateRefunds,
        packagePaymentRefunds,
        stripeCustomerProvisioning,
        stripeCheckoutCleanups,
        billingRefunds,
      ]) => {
        console.log("Scheduled reconciliation completed", {
          storageUploads,
          jobs,
          deletedAccountJobs,
          topUpRefunds,
          topUpDuplicateRefunds,
          packagePaymentRefunds,
          stripeCustomerProvisioning,
          stripeCheckoutCleanups,
          billingRefunds,
        });
        if (topUpRefunds.interventionRequired > 0) {
          console.error("Top-up refunds require manual intervention", {
            count: topUpRefunds.interventionRequired,
          });
        }
        if (topUpDuplicateRefunds.interventionRequired > 0) {
          console.error("Top-up duplicate refunds require manual intervention", { count: topUpDuplicateRefunds.interventionRequired });
        }
        if (billingRefunds.interventionRequired > 0) {
          console.error("Billing refunds require manual intervention", {
            count: billingRefunds.interventionRequired,
          });
        }
        if (packagePaymentRefunds.interventionRequired > 0) {
          console.error("Package payment refunds require manual intervention", {
            count: packagePaymentRefunds.interventionRequired,
          });
        }
        if (stripeCustomerProvisioning.interventionRequired > 0) {
          console.error("Stripe Customer provisioning requires manual intervention", {
            count: stripeCustomerProvisioning.interventionRequired,
          });
        }
        if (stripeCheckoutCleanups.interventionRequired > 0) {
          console.error("Stripe Checkout cleanups require manual intervention", {
            count: stripeCheckoutCleanups.interventionRequired,
          });
        }
        if (stripeCheckoutCleanups.detachedIntervention > 0) {
          console.error("Detached package checkout recovery requires manual intervention", {
            count: stripeCheckoutCleanups.detachedIntervention,
          });
        }
      }),
    );
  },
};
