// Service-only image editing Worker. The Web Worker authenticates its cookie
// session and forwards a short-lived bearer token; this Worker still verifies
// that token in the existing image endpoint before reserving usage.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Hono } from "hono";
import { boundedBody, apiRequestBodyLimit } from "@beutl/core";
import { runWithDbProvider } from "@beutl/db";
import { apiErrorResponse, apiOnErrorHandler, fileTooLargeApiResponse } from "./api/error";
import { getUserIdFromHeaders } from "./api/auth";
import { setR2BucketProvider, type R2BucketLike } from "./ai/r2-provider";
import { resolveStorageBucket } from "./storage/bucket-from-env";
import aiImages from "./v3/ai/images";

export interface ImageWorkerEnv {
  BEUTL_DATABASE_HYPERDRIVE: { connectionString: string };
  BEUTL_R2_BUCKET?: R2BucketLike;
  JWT_SECRET?: string;
  JWT_ISSUER?: string;
  JWT_AUDIENCE?: string;
  PUBLIC_ORIGIN?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_REQUEST_TIMEOUT_MS?: string;
  VERCEL_AI_GATEWAY_API_KEY?: string;
  VERCEL_AI_GATEWAY_REQUEST_TIMEOUT_MS?: string;
  BEUTL_STORAGE_PROVIDER?: string;
  BEUTL_S3_ENDPOINT?: string;
  BEUTL_S3_BUCKET?: string;
  BEUTL_S3_REGION?: string;
  BEUTL_S3_ACCESS_KEY_ID?: string;
  BEUTL_S3_SECRET_ACCESS_KEY?: string;
  BEUTL_S3_SESSION_TOKEN?: string;
  BEUTL_S3_FORCE_PATH_STYLE?: string;
  BEUTL_S3_ALLOW_INSECURE_HTTP?: string;
}

const EDIT_PATH = "/api/v3/ai/images/edit";
const RUNTIME_KEYS = [
  "JWT_SECRET", "JWT_ISSUER", "JWT_AUDIENCE", "PUBLIC_ORIGIN",
  "OPENROUTER_API_KEY", "OPENROUTER_REQUEST_TIMEOUT_MS",
  "VERCEL_AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_REQUEST_TIMEOUT_MS",
  "BEUTL_STORAGE_PROVIDER", "BEUTL_S3_ENDPOINT", "BEUTL_S3_BUCKET",
  "BEUTL_S3_REGION", "BEUTL_S3_ACCESS_KEY_ID", "BEUTL_S3_SECRET_ACCESS_KEY",
  "BEUTL_S3_SESSION_TOKEN", "BEUTL_S3_FORCE_PATH_STYLE",
  "BEUTL_S3_ALLOW_INSECURE_HTTP",
] as const;

const app = new Hono()
  .basePath("/api/v3/ai/images")
  .route("/", aiImages)
  .onError(apiOnErrorHandler);

function configureRuntime(env: ImageWorkerEnv): string {
  const connectionString = env.BEUTL_DATABASE_HYPERDRIVE?.connectionString;
  if (!connectionString) throw new Error("Image Worker database binding is missing");
  if (!env.JWT_SECRET) throw new Error("Image Worker JWT secret is missing");
  for (const key of RUNTIME_KEYS) {
    const value = env[key];
    if (typeof value === "string") process.env[key] = value;
  }
  setR2BucketProvider(() => resolveStorageBucket(env));
  return connectionString;
}

export async function fetchImageEdit(request: Request, env: ImageWorkerEnv): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== EDIT_PATH) {
    await request.body?.cancel();
    return new Response(null, { status: 404 });
  }
  const limit = apiRequestBodyLimit(
    request.method,
    EDIT_PATH,
    request.headers.get("content-type"),
  );
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
      await request.body?.cancel();
      return await fileTooLargeApiResponse();
    }
  }
  const connectionString = configureRuntime(env);
  // Reject unauthenticated requests before locking the body into a stream
  // wrapper. The image endpoint verifies the same token again before billing.
  if (!await getUserIdFromHeaders(request.headers)) {
    await request.body?.cancel();
    return Response.json(await apiErrorResponse("authenticationIsRequired"), { status: 401 });
  }
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString, maxUses: 1 }),
  });
  try {
    return await runWithDbProvider(async () => db, async () => {
      let bodyLimitExceeded = false;
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      const bounded = request.body
        ? new Request(request.url, {
            method: "POST",
            headers,
            body: boundedBody(request.body, limit, () => { bodyLimitExceeded = true; }),
            signal: request.signal,
            duplex: "half",
          } as RequestInit & { duplex: "half" })
        : request;
      try {
        const response = await app.fetch(bounded, {
          ...env,
          // Only the private Web-authenticated path sends prepared canvases.
          AI_IMAGE_PREPARED_OUTPAINT: true,
        });
        return bodyLimitExceeded ? await fileTooLargeApiResponse() : response;
      } catch (error) {
        if (bodyLimitExceeded) return await fileTooLargeApiResponse();
        throw error;
      }
    });
  } finally {
    await db.$disconnect();
  }
}

export default { fetch: fetchImageEdit };
