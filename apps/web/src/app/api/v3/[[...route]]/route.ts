import { Hono } from "hono";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { v3 } from "@beutl/api";

const app = new Hono().basePath("/api/v3").route("/", v3);

// Give Hono the same bindings and execution context as the Worker entry, so
// routes that read bindings (Hosted Git) behave as they do in apps/web/worker.js
// and video callbacks can finish with waitUntil(). Outside a Worker context
// (unit tests) Hono runs without them.
function fetchV3(request: Request): Response | Promise<Response> {
  let context: ReturnType<typeof getCloudflareContext> | null = null;
  try { context = getCloudflareContext(); } catch {
    // Only unit tests import this route outside a Worker or next dev context.
    return app.fetch(request);
  }
  const executionCtx = context.ctx;
  return app.fetch(request, context.env, executionCtx && typeof executionCtx === "object" &&
    "waitUntil" in executionCtx && typeof executionCtx.waitUntil === "function"
    ? executionCtx as Parameters<typeof app.fetch>[2]
    : undefined);
}

export const GET = fetchV3;
export const HEAD = fetchV3;
export const POST = fetchV3;
export const PUT = fetchV3;
export const PATCH = fetchV3;
export const DELETE = fetchV3;
// Next would otherwise answer OPTIONS itself; tus discovery is an API route.
export const OPTIONS = fetchV3;
