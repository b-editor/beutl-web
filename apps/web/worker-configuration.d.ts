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
		BEUTL_GIT_REPOSITORIES: DurableObjectNamespace;
		BEUTL_GIT_ENABLED?: string;
		BEUTL_S3_ENDPOINT?: string;
		BEUTL_S3_REGION?: string;
		BEUTL_S3_BUCKET?: string;
		BEUTL_S3_ACCESS_KEY_ID?: string;
		BEUTL_S3_SECRET_ACCESS_KEY?: string;
		BEUTL_S3_SESSION_TOKEN?: string;
		BEUTL_S3_FORCE_PATH_STYLE?: string;
		ASSETS: Fetcher;
	}
}
interface CloudflareEnv extends Cloudflare.Env {}
