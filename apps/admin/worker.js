import { fetchWithBodyLimit } from "@beutl/api/worker-body-limit";
import openNext from "./.open-next/worker.js";

export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";

const worker = {
  async fetch(request, env, ctx) {
    // Admin actions carry form fields only; keep Next's default 1 MiB cap
    // outside OpenNext as well, before authentication or body buffering.
    return fetchWithBodyLimit(request, env, ctx,
      (bounded, nextEnv, nextCtx) => openNext.fetch(bounded, nextEnv, nextCtx),
      1024 * 1024);
  },
};

export default worker;
