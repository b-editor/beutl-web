import { Hono } from "hono";
import { handle } from "hono/vercel";
import { v2 } from "@beutl/api";

// @deprecated Legacy single-route shim that 307s into the native-auth flow.
// Kept for old desktop builds; remove once client telemetry confirms it is unused.
const app = new Hono().basePath("/api/v2").route("/", v2);

export const GET = handle(app);
