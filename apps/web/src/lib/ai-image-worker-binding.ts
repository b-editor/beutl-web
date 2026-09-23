import { getCloudflareContext } from "@opennextjs/cloudflare";

/** The private service is absent only in local Next development. */
export function getImageWorkerBinding(): { fetch(request: Request): Promise<Response> } | null {
  let env: CloudflareEnv;
  try {
    env = getCloudflareContext().env;
  } catch (error) {
    if (process.env.NODE_ENV !== "development") throw error;
    return null;
  }
  if (!env.AI_IMAGE_WORKER) {
    throw new Error("AI_IMAGE_WORKER service binding is missing");
  }
  return env.AI_IMAGE_WORKER;
}
