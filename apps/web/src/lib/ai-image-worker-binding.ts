import { env } from "cloudflare:workers";

/** The private service is not running in local development. */
export function getImageWorkerBinding(): { fetch(request: Request): Promise<Response> } | null {
  if (process.env.NODE_ENV === "development") return null;
  if (!env.AI_IMAGE_WORKER) {
    throw new Error("AI_IMAGE_WORKER service binding is missing");
  }
  return env.AI_IMAGE_WORKER;
}
