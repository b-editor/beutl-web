import { Hono } from "hono";
import app_ from "./v1/app";
import account from "./v1/account";
import { apiOnErrorHandler } from "./api/error";

// basePath 無しの composed app。消費側 (Web route.ts / Worker) が
// プレフィックス (/api/v1) を付与してマウントする。
export const v1 = new Hono()
  .route("/app", app_)
  .route("/account", account)
  .onError(apiOnErrorHandler);
