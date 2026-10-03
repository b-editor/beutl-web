/* eslint-disable */
// Worker bindings are generated from apps/web/wrangler.jsonc by Wrangler.
// Keep only the bindings consumed by the application here; the full generated
// runtime declarations are supplied by @cloudflare/workers-types.
declare namespace Cloudflare {
	interface Env {
		BEUTL_R2_BUCKET: R2Bucket;
		AI_IMAGE_WORKER: Fetcher /* beutl-ai-images */;
    BEUTL_DATABASE_HYPERDRIVE: Hyperdrive;
		ASSETS: Fetcher;
	}
}
interface CloudflareEnv extends Cloudflare.Env {}
