import { Hono } from "hono";
import { handle } from "hono/vercel";

import app_ from "./app";
import account from "./account";
import { apiOnErrorHandler } from "@/lib/api/error";

const app = new Hono()
  .basePath("/api/v1")
  .route("/app", app_)
  .route("/account", account)
  .onError(apiOnErrorHandler);

export const GET = handle(app);
export const POST = handle(app);
