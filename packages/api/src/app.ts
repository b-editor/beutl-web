import { Hono } from "hono";
import { v1 } from "./v1";
import { v2 } from "./v2";
import { v3 } from "./v3";

// Both the Web Worker and Next.js routes use these HTTP applications.
export const api = new Hono()
  .route("/api/v1", v1)
  .route("/api/v2", v2)
  .route("/api/v3", v3);

export { v1, v2, v3 };
