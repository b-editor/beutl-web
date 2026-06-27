import { Hono } from "hono";
import { handle } from "hono/vercel";

import discover from "./discover";
import files from "./files";
import library from "./library";
import packages from "./packages";
import users from "./users";
import user from "./user";
import app_ from "./app";
import { apiOnErrorHandler } from "@/lib/api/error";

const app = new Hono()
  .basePath("/api/v3")
  .route("/discover", discover)
  .route("/files", files)
  .route("/account/library", library)
  .route("/packages", packages)
  .route("/users", users)
  .route("/user", user)
  .route("/app", app_)
  .onError(apiOnErrorHandler);

export const GET = handle(app);
export const POST = handle(app);
export const DELETE = handle(app);
