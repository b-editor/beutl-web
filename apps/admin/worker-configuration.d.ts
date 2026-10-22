/* eslint-disable */
// Application bindings after worker.js resolves Secrets Store values to strings.
interface CloudflareEnv {
	NEXT_INC_CACHE_R2_BUCKET: R2Bucket;
	BEUTL_R2_BUCKET: R2Bucket;
	WORKER_SELF_REFERENCE: Fetcher /* beutl-admin */;
	BEUTL_DATABASE_HYPERDRIVE: Hyperdrive;
	ASSETS: Fetcher;
}
