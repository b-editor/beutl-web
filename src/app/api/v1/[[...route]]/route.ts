import { Hono } from "hono";
import { handle } from "hono/vercel";
import { HTTPException } from "hono/http-exception";

import app_ from "./app";
import account from "./account";
import { apiErrorResponse } from "@/lib/api/error";
import { JwtTokenExpired } from "hono/utils/jwt/types";

export const runtime = "edge";

const app = new Hono().basePath("/api/v1");

const route = app
  .route("/app", app_)
  .route("/account", account)
  .onError(async (err, c) => {
    console.error(err);
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    if (err instanceof JwtTokenExpired) {
      return c.json(await apiErrorResponse("authenticationIsRequired"), {
        status: 401,
      });
    }
    return c.json(await apiErrorResponse("unknown"), {
      status: 500,
    });
  });

export type AppType = typeof route;

export const GET = handle(app);
export const POST = handle(app);
