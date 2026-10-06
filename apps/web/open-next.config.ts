import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

export default defineCloudflareConfig({
  incrementalCache: process.env.BEUTL_PR_PREVIEW === "1" ? "dummy" : r2IncrementalCache,
});
