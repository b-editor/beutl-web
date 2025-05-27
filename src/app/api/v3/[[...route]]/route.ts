import { Hono } from "hono";
import { handle } from "hono/vercel";

import discover from "./discover";
import files from "./files";
import library from "./library";
import packages from "./packages";
import users from "./users";
import user from "./user";
import app_ from "./app";
import { apiErrorResponse } from "@/lib/api/error";
import { HTTPException } from "hono/http-exception";
import { JwtTokenExpired } from "hono/utils/jwt/types";

const app = new Hono().basePath("/api/v3");

const route = app
  .route("/discover", discover)
  .route("/files", files)
  .route("/account/library", library)
  .route("/packages", packages)
  .route("/users", users)
  .route("/user", user)
  .route("/app", app_)
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
export const DELETE = handle(app);
