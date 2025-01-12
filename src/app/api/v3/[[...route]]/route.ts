import { Hono } from "hono";
import { handle } from "hono/vercel";

import discover from "./discover";
import files from "./files";
import library from "./library";
import packages from "./packages";
import users from "./users";

export const runtime = "edge";

const app = new Hono().basePath("/api/v3");

const route = app
  .route("/discover", discover)
  .route("/files", files)
  .route("/library", library)
  .route("/packages", packages)
  .route("/users", users);

export type AppType = typeof route;

export const GET = handle(app);
export const POST = handle(app);
export const DELETE = handle(app);
