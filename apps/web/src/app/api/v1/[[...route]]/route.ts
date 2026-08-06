import { Hono } from "hono";
import { handle } from "hono/vercel";
import { v1 } from "@beutl/api";

const app = new Hono().basePath("/api/v1").route("/", v1);

export const GET = handle(app);
export const POST = handle(app);
