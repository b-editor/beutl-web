/* eslint-disable */
// Worker bindings are generated from apps/web/wrangler.jsonc by Wrangler.
// Keep only the bindings consumed by the application here; the full generated
// runtime declarations are supplied by @cloudflare/workers-types.
declare namespace Cloudflare {
	interface Env {
		NEXT_INC_CACHE_R2_BUCKET: R2Bucket;
		BEUTL_R2_BUCKET: R2Bucket;
		AI_IMAGE_WORKER: Fetcher /* beutl-ai-images */;
		WORKER_SELF_REFERENCE: Fetcher /* beutl-web */;
    BEUTL_DATABASE_HYPERDRIVE: Hyperdrive;
		ASSETS: Fetcher;
	}
}
interface CloudflareEnv extends Cloudflare.Env {}
