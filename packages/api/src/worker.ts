// beutl-web-api: デスクトップアプリ向け API 専用 Cloudflare Worker。
// 同一ドメイン・パス分割 (beutl.beditor.net/api/v{1,2,3}/*) で受ける。
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { setDbProvider } from "@beutl/db";
import {
  boundedBody,
  apiRequestBodyLimit,
} from "@beutl/core";
import { api } from "@beutl/api";
import { fileTooLargeApiResponse } from "./api/error";
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
import {
  abandonStaleStorageUploads,
  reconcileStorageMultipartCleanups,
} from "./storage-uploads";
import { resolveStorageBucket } from "./storage/bucket-from-env";
import { reconcileGitResurrectionTombstones, reconcileGitAccountDeletionTombstones, retryGitRepositoryRepairs, missingForgejoConfig, releaseExpiredGitAccountDeletionBlocks, retryPendingGitDeletions } from "@beutl/forgejo";

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
  // 解決は最初のストレージ呼び出しまで遅らせる。ストレージを使わない
  // ルートまで設定不備で落とさないため。
  setR2BucketProvider(() => resolveStorageBucket(env));
}

// Only GET and HEAD are bodyless. Other methods may carry a body that the
// downstream handler reads.
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
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

function withBoundedBody(
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
  /**
   * 退会の後始末をやり残していたら片付ける。
   *
   * Forgejo が落ちている間に退会があると purge が失敗し、GitAccountDeletion に
   * 残る。利用者のリクエストの中で拾うと、その人の応答が遅くなるうえ、退会が
   * 起きるまで永久に残る。定期実行でだけ消化する。
   *
   * 併せて、退会を始めたまま消えた処理の印も外す。これを外さないと、その利用者は
   * 資格情報の発行も、やり直しの退会もできないまま固まる。
   */
  async reconcileGitDeletions(): Promise<void> {

    // **黙って抜けない。** ここで止まると、退会のやり直しも、復活したアカウントの
    // 消し直しも、リポジトリの直しも全部止まる。どれも利用者からは見えないので、
    // 気付ける手がかりはここしかない。
    //
    // ログに出すだけでなく投げる。cron の失敗として記録が残らないと、ログを
    // 読みにいく人がいない限り、止まっていることに誰も気付けない。
    const missing = missingForgejoConfig();
    if (missing.length > 0) {
      const message =
        `git cleanup did not run: ${missing.join(", ")} ` +
        "is not set on beutl-web-api";
      console.error(message);
      throw new Error(message);
    }

    try {
      const stale = await releaseExpiredGitAccountDeletionBlocks();
      if (stale.released > 0 || stale.review > 0) {
        console.log(
          `git deletions: released ${stale.released} stale markers, ` +
            `${stale.review} sent to review`,
        );
      }
    } catch (error) {
      console.error("failed to release stale Git deletion markers", error);
    }

    try {
      const { finished, pending, review } = await retryPendingGitDeletions();
      if (finished > 0 || pending > 0) {
        console.log(
          `git deletions: finished ${finished}, still pending ${pending}`,
        );
      }
      // 自動では決着しない分。誰も見ないと Forgejo に生きたアカウントが残るので、
      // 件数を毎回出して気付けるようにする (0 のときは黙る)。
      if (review > 0) {
        console.error(
          `git deletions: ${review} entries need a human decision ` +
            "(GitAccountDeletion.phase = NEEDS_REVIEW)",
        );
      }
    } catch (error) {
      console.error("failed to retry pending Git deletions", error);
    }

    // 消したはずのアカウントが戻っていないかを見る。Forgejo だけを退会前へ
    // 復元すると、利用者もトークンも復活するが beutl-web 側には何も残らない。
    try {
      const { checked, repurged, review, failed, remaining } =
        await reconcileGitAccountDeletionTombstones({ drain: true });
      if (checked > 0 || failed > 0) {
        console.log(
          `git tombstones: checked ${checked}, repurged ${repurged}, ` +
            `failed ${failed}, remaining ${remaining}`,
        );
      }
      if (repurged > 0) {
        console.error(
          `git deletions: ${repurged} purged Forgejo accounts had come back ` +
            "and were removed again",
        );
      }
      if (review > 0) {
        console.error(
          `git deletions: ${review} purge tombstones need a human decision`,
        );
      }
    } catch (error) {
      console.error("failed to reconcile Git purge tombstones", error);
    }

    // 失効させたトークンと消したリポジトリが、復元で生き返っていないかを見る。
    // 退会の墓標には現れない (アカウントは生きているため)。ここを回さないと、
    // 端末に平文の残る失効済みトークンが通るようになっていても気付けない。
    try {
      const {
        checked,
        revoked,
        deleted,
        review,
        failed,
        pruned,
        confirmed,
        dropped,
        repaired,
      } = await reconcileGitResurrectionTombstones({ drain: true });
      // **決着させただけの回も黙らない。** 復元が無い間の cron はここしか動かない
      // ので、出さないと「何もしていない」のか「動いていない」のか分からない。
      if (
        checked > 0 ||
        failed > 0 ||
        pruned > 0 ||
        confirmed > 0 ||
        dropped > 0 ||
        repaired > 0
      ) {
        console.log(
          `git resurrection: confirmed ${confirmed}, dropped ${dropped}, ` +
            `repaired ${repaired}, checked ${checked}, revoked ${revoked}, ` +
            `deleted ${deleted}, failed ${failed}, pruned ${pruned}`,
        );
      }
      // 消えていなかったので控えを外した = 利用者の消去が通っていなかった。
      if (dropped > 0) {
        console.error(
          `git resurrection: ${dropped} deletions never took effect and their ` +
            "tombstones were dropped (the user's request did not go through)",
        );
      }
      if (revoked > 0 || deleted > 0) {
        console.error(
          `git resurrection: ${revoked} revoked credentials and ${deleted} ` +
            "deleted repositories had come back and were removed again",
        );
      }
      if (review > 0) {
        console.error(
          `git resurrection: ${review} deletion tombstones need a human ` +
            "decision (the repository id points at something else now)",
        );
      }
    } catch (error) {
      console.error("failed to reconcile Git resurrection tombstones", error);
    }

    // テンプレートを入れ切れなかったリポジトリを入れ直す。残っている間は
    // .gitattributes が無いので、push された素材が LFS に載らない。
    try {
      const { fixed, pending, review } = await retryGitRepositoryRepairs();
      if (fixed > 0) {
        console.log(`git repositories: settled ${fixed}`);
      }
      if (pending > 0) {
        console.error(
          `git repositories: ${pending} are still unfinished (missing Beutl ` +
            "defaults, or held by the admin and not handed over)",
        );
      }
      if (review > 0) {
        console.error(
          `git repositories: ${review} need a human decision ` +
            "(GitRepositoryRepair.needsReview)",
        );
      }
    } catch (error) {
      console.error("failed to repair Git repositories", error);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    // Bound the body before routing. Some v1 handlers parse JSON before auth,
    // so declared and streamed sizes must be rejected at the Worker boundary.
    let bodyLimitExceeded = false;
    const bounded = withBoundedBody(request, () => {
      bodyLimitExceeded = true;
    });
    if (bounded === null) {
      return await fileTooLargeApiResponse();
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
        ? await fileTooLargeApiResponse()
        : response;
    } catch (error) {
      if (bodyLimitExceeded) return await fileTooLargeApiResponse();
      throw error;
    }
  },
  async scheduled(
    controller: ScheduledControllerLike,
    env: Env,
    context: ExecutionContextLike,
  ): Promise<void> {
    configureRuntime(env);
    context.waitUntil(this.reconcileGitDeletions());
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
        reconcileStorageMultipartCleanups(scheduledAt),
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
        storageMultipartCleanups,
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
          storageMultipartCleanups,
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
