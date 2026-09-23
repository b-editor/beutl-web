/* eslint-disable */
// Cloudflare bindings used by the Web Worker; keep in sync with wrangler.jsonc.
declare namespace Cloudflare {
	interface Env {
		NEXT_INC_CACHE_R2_BUCKET: R2Bucket;
		BEUTL_R2_BUCKET: R2Bucket;
		WORKER_SELF_REFERENCE: Fetcher /* beutl-web */;
		BEUTL_API_WORKER: Fetcher /* beutl-web-api */;
    BEUTL_DATABASE_HYPERDRIVE: Hyperdrive;
		ASSETS: Fetcher;
	}
}
interface CloudflareEnv extends Cloudflare.Env {}
