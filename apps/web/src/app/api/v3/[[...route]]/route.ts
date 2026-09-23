import { Hono } from "hono";
import { handle } from "hono/vercel";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { v3 } from "@beutl/api";

const app = new Hono().basePath("/api/v3").route("/", v3);

export const GET = handle(app);
export const POST = (request: Request) => {
  // Pass the Worker context through to Hono so video callbacks can acknowledge
  // quickly while their result is finalized with waitUntil(). Next dev has no
  // Worker context and retains Hono's synchronous fallback.
  let context: ReturnType<typeof getCloudflareContext> | null = null;
  try { context = getCloudflareContext(); } catch { /* Next dev has none. */ }
  return context
    ? app.fetch(request, context.env, context.ctx)
    : app.fetch(request);
};
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
