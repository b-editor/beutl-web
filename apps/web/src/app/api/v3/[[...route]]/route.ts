import { Hono } from "hono";
import { handle } from "hono/vercel";
import { env, waitUntil } from "cloudflare:workers";
import { v3 } from "@beutl/api";

const app = new Hono().basePath("/api/v3").route("/", v3);

export const GET = handle(app);
// Pass the Worker bindings and waitUntil() through to Hono so video callbacks
// can acknowledge quickly while their result is finalized in the background.
const executionCtx = {
  waitUntil,
  passThroughOnException() {},
  props: {},
} as unknown as Parameters<typeof app.fetch>[2];

export const POST = (request: Request) => app.fetch(request, env, executionCtx);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
