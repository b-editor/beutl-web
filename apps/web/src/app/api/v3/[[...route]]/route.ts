import { Hono } from "hono";
import { handle } from "hono/vercel";
import { v3 } from "@beutl/api";

const app = new Hono().basePath("/api/v3").route("/", v3);

export const GET = handle(app);
export const POST = handle(app);
export const DELETE = handle(app);
