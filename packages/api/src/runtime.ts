// Shared API runtime embedded in apps/web/worker.js.
// Public APIs and their scheduled work deploy together with beutl-web. This
// entry owns bindings, body limits, the execution context and cron; Hono owns
// every API route, including Hosted Git (v3/repos, v3/git).
export { GitRepositoryDurableObject } from "./git/repo-durable-object";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { runWithDbProvider } from "@beutl/db";
import { runWithR2BucketProvider } from "./ai/r2-provider";
import {
  boundedBody,
  apiRequestBodyLimit,
} from "@beutl/core";
import { api } from "@beutl/api";
import { fileTooLargeApiResponse } from "./api/error";
import {
  reconcileAiJobs,
  type R2BucketLike,
  reconcileStripeCustomerProvisioning,
} from "@beutl/api";
import { reconcileDeletedAccountRemoteJobs } from "./ai/remote-job-cleanup";
import { reconcileBillingRefunds } from "./ai/billing-refunds";
import { reconcileTopUpRefunds } from "./ai/top-up-refunds";
import { reconcilePackagePaymentRefunds } from "./ai/package-payment-refunds";
import { reconcileTopUpDuplicateRefunds } from "./ai/topup-duplicate-refunds";
import { reconcileStripeCheckoutCleanups } from "./ai/stripe-checkout-cleanups";
import {
  abandonStaleStorageUploads,
  reconcileStorageMultipartCleanups,
} from "./storage-uploads";
import { resolveStorageBucket } from "./storage/bucket-from-env";
import type { GitEnvironment } from "./git/environment";
import {
  reconcileGitHistoryReservations,
  reconcileGitLfsReservations,
  reconcileGitRepositoryDeletions,
} from "./git/maintenance";

export interface Env extends GitEnvironment {
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
  // オブジェクトストレージ。既定は R2 バインディング。BEUTL_STORAGE_PROVIDER=s3
  // のときは BEUTL_S3_* から S3 互換ストレージへ接続する (docs/deployment.md)。
  BEUTL_R2_BUCKET?: R2BucketLike;
  BEUTL_STORAGE_PROVIDER?: string;
  BEUTL_S3_ENDPOINT?: string;
  BEUTL_S3_BUCKET?: string;
  BEUTL_S3_REGION?: string;
  BEUTL_S3_ACCESS_KEY_ID?: string;
  BEUTL_S3_SECRET_ACCESS_KEY?: string;
  BEUTL_S3_SESSION_TOKEN?: string;
  BEUTL_S3_FORCE_PATH_STYLE?: string;
  STRIPE_SECRET_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_WEBHOOK_SECRET?: string;
  OPENROUTER_REQUEST_TIMEOUT_MS?: string;
  // Vercel AI Gateway. No webhook secret binding: the Gateway signs each job's
  // deliveries with a secret of that job's own, returned on the start response
  // and stored on the job row rather than held here.
  VERCEL_AI_GATEWAY_API_KEY?: string;
  VERCEL_AI_GATEWAY_REQUEST_TIMEOUT_MS?: string;
}

type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

type ScheduledControllerLike = {
  scheduledTime: number;
};

type ApiExecutionContext = NonNullable<Parameters<typeof api.fetch>[2]>;

/** Keep API requests and cron jobs from replacing Next.js's global providers. */
export async function withApiBindings<T>(
  env: Env,
  work: (context?: ApiExecutionContext) => Promise<T>,
  context?: ApiExecutionContext,
): Promise<T> {
  // Legacy JWT/version helpers read process.env. All invocations in this Web
  // deployment use the same string bindings; object bindings stay in env.
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") process.env[key] = value;
  }
  let client: PrismaClient | undefined;
  const provider = async () => {
    if (!client) {
      const connectionString = env.BEUTL_DATABASE_HYPERDRIVE?.connectionString;
      if (!connectionString) throw new Error("BEUTL_DATABASE_HYPERDRIVE binding not found");
      client = new PrismaClient({ adapter: new PrismaPg({ connectionString, maxUses: 1 }) });
    }
    return client;
  };
  const pending: Promise<unknown>[] = [];
  const scopedContext: ApiExecutionContext | undefined = context && {
    waitUntil(promise) {
      pending.push(promise);
      context.waitUntil(promise);
    },
    passThroughOnException: () => context.passThroughOnException(),
    props: context.props,
    exports: context.exports,
  };
  try {
    return await runWithDbProvider(provider, () => runWithR2BucketProvider(
      () => resolveStorageBucket(env),
      () => work(scopedContext),
    ));
  } finally {
    const dispose = async () => {
      // AI submissions may keep using the invocation's DB after returning 202.
      // Drain newly registered work as well before closing its connection pool.
      for (let completed = 0; completed < pending.length;) {
        const batch = pending.slice(completed);
        completed = pending.length;
        await Promise.allSettled(batch);
      }
      await client?.$disconnect();
    };
    if (context) context.waitUntil(dispose());
    else await dispose();
  }
}

/** Only versioned desktop APIs bypass OpenNext's full-body buffering. */
export function isApiRequest(request: Request): boolean {
  return /^\/api\/v[123](?:\/|$)/u.test(new URL(request.url).pathname);
}

// Only GET and HEAD are bodyless. Other methods may carry a body that the
// downstream handler reads.
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const STORAGE_PART_PATH = /^\/api\/v3\/storage\/uploads\/[^/]+\/parts\/\d+$/u;
const TUS_UPLOAD_PATH = /^\/api\/v3\/git\/[^/]+\.git\/info\/lfs\/objects\/[0-9a-f]{64}\/tus(?:\/[^/]*)?$/u;

/** tus clients require Tus-Resumable on every response, including this boundary's 413. */
async function bodyTooLarge(request: Request): Promise<Response> {
  const response = await fileTooLargeApiResponse();
  if (TUS_UPLOAD_PATH.test(new URL(request.url).pathname)) response.headers.set("Tus-Resumable", "1.0.0");
  return response;
}
/**
 * Keep the outer Worker cap aligned with the parser used by each route. The
 * outer cap is a memory guard, while the endpoint parser remains the source
 * of the precise multipart error response.
 */
export function requestBodyLimitForWorker(
  method: string,
  pathname: string,
  contentType: string | null,
): number {
  return apiRequestBodyLimit(method, pathname, contentType);
}

export function withBoundedBody(
  request: Request,
  onLimitExceeded: () => void,
): Request | null {
  if (BODYLESS_METHODS.has(request.method) || !request.body) return request;

  const limit = requestBodyLimitForWorker(
    request.method,
    new URL(request.url).pathname,
    request.headers.get("content-type"),
  );

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
      return null;
    }
  }

  const headers = new Headers(request.headers);
  const pathname = new URL(request.url).pathname;
  // Multipart storage providers require the declared part length; the route
  // additionally bounds the stream to that length before handing it to storage.
  if (!(request.method === "PUT" && STORAGE_PART_PATH.test(pathname)) &&
      !(request.method === "PATCH" && TUS_UPLOAD_PATH.test(pathname)))
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
  async fetch(request: Request, env: Env, context?: ApiExecutionContext): Promise<Response> {
    // Bound the body before routing. Some v1 handlers parse JSON before auth,
    // so declared and streamed sizes must be rejected at the Worker boundary.
    let bodyLimitExceeded = false;
    const bounded = withBoundedBody(request, () => {
      bodyLimitExceeded = true;
    });
    if (bounded === null) return bodyTooLarge(request);

    return withApiBindings(env, async (scopedContext) => {
      try {
        const response = await api.fetch(bounded, env, scopedContext);
        // Hono's JSON parser can turn a stream error into a generic 400 before
        // the endpoint sees it. The outer stream marker still gives the Worker
        // an unambiguous 413 response for chunked bodies.
        return bodyLimitExceeded ? bodyTooLarge(request) : response;
      } catch (error) {
        if (bodyLimitExceeded) return bodyTooLarge(request);
        throw error;
      }
    }, context);
  },
  async scheduled(
    controller: ScheduledControllerLike,
    env: Env,
    context: ExecutionContextLike,
  ): Promise<void> {
    context.waitUntil(withApiBindings(env, async () => {
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
      const reconciliations = [
          abandonStaleStorageUploads(scheduledAt),
          reconcileStorageMultipartCleanups(scheduledAt),
          reconcileAiJobs(scheduledAt),
          reconcileDeletedAccountRemoteJobs(scheduledAt),
          reconcileTopUpRefunds(scheduledAt, env.STRIPE_SECRET_KEY),
          topUpDuplicateRefunds,
          packagePaymentRefunds,
          reconcileStripeCustomerProvisioning(scheduledAt, env.STRIPE_SECRET_KEY),
          stripeCheckoutCleanups,
          reconcileBillingRefunds(scheduledAt, env.STRIPE_SECRET_KEY),
          reconcileGitRepositoryDeletions(env),
          reconcileGitLfsReservations(env),
          reconcileGitHistoryReservations(env),
        ] as const;
      await Promise.all(reconciliations).catch(async (error) => {
        // Do not close this invocation's DB while another reconciler is active.
        await Promise.allSettled(reconciliations);
        throw error;
      }).then(([
          storageUploads,
          storageMultipartCleanups,
          jobs,
          deletedAccountJobs,
          topUpRefunds,
          topUpDuplicateRefunds,
          packagePaymentRefunds,
          stripeCustomerProvisioning,
          stripeCheckoutCleanups,
          billingRefunds,
          gitDeletions,
          gitLfsReservations,
          gitHistoryReservations,
        ]) => {
          console.log("Scheduled reconciliation completed", {
            storageUploads,
            storageMultipartCleanups,
            jobs,
            deletedAccountJobs,
            topUpRefunds,
            topUpDuplicateRefunds,
            packagePaymentRefunds,
            stripeCustomerProvisioning,
            stripeCheckoutCleanups,
            billingRefunds,
            gitDeletions,
            gitLfsReservations,
            gitHistoryReservations,
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
        });
    }));
  },
};
