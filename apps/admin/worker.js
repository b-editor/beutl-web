import { runWithConfiguredDbProviderResponseScope } from "@beutl/db/provider-scope";
//@ts-expect-error: Will be resolved by wrangler build
import openNext from "./.open-next/worker.js";

//@ts-expect-error: Will be resolved by wrangler build
export { DOQueueHandler } from "./.open-next/worker.js";
//@ts-expect-error: Will be resolved by wrangler build
export { DOShardedTagCache } from "./.open-next/worker.js";
//@ts-expect-error: Will be resolved by wrangler build
export { BucketCachePurge } from "./.open-next/worker.js";

function withWaitUntil(context, waitUntil) {
  return new Proxy(context, {
    get(target, property, receiver) {
      if (property === "waitUntil") return waitUntil;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    return await runWithConfiguredDbProviderResponseScope(
      (waitUntil) =>
        openNext.fetch(request, env, withWaitUntil(ctx, waitUntil)),
      ctx.waitUntil.bind(ctx),
    );
  },
};
