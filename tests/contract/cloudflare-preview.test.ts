import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePreviewInput, previewConfig, previewNames } from "../../scripts/cloudflare-preview.mjs";

const base = JSON.parse(readFileSync(new URL("../../apps/image-worker/wrangler.jsonc", import.meta.url), "utf8"));
const input = {
  hyperdriveId: "a".repeat(32),
  r2Bucket: "beutl-preview-data",
  secrets: {
    web: { BETTER_AUTH_SECRET: "preview-auth", JWT_SECRET: "preview-api", AI_IMAGE_WORKER_JWT_SECRET: "preview-image" },
    admin: { BETTER_AUTH_SECRET: "preview-auth" },
    "image-worker": {},
  },
};
const settings = () => parsePreviewInput(JSON.stringify(input));

describe("Cloudflare PR previews", () => {
  it.each(["0", "-1", "1/path", "1;exit", "NaN", "9007199254740992"])("rejects unsafe PR identifiers: %s", (value) => {
    expect(() => previewNames(value)).toThrow();
  });

  it("keeps the image Worker private and derives the matching scoped JWT secret", () => {
    const value = settings();
    const result = previewConfig(base, "image-worker", "229", "preview-account", value, "/workspace/apps/image-worker");
    expect(result.config.name).toBe("beutl-ai-images-pr-229");
    expect(result.config.workers_dev).toBe(false);
    expect(result.config.preview_urls).toBe(false);
    expect(value.secrets["image-worker"].JWT_SECRET).toBe(value.secrets.web.AI_IMAGE_WORKER_JWT_SECRET);
  });

  it("maps Web service bindings, data, assets and origins to the same PR", () => {
    const web = { ...base, name: "beutl-web", main: "worker.js", assets: { directory: ".open-next/assets", binding: "ASSETS" }, services: [
      { binding: "AI_IMAGE_WORKER", service: "beutl-ai-images" },
      { binding: "WORKER_SELF_REFERENCE", service: "beutl-web" },
    ], r2_buckets: [...base.r2_buckets, { binding: "NEXT_INC_CACHE_R2_BUCKET", bucket_name: "beutl-web-inc-cache" }], triggers: { crons: ["*/5 * * * *"] } };
    const snapshot = structuredClone(web);
    const result = previewConfig(web, "web", "229", "preview-account", settings(), "/workspace/apps/web");
    expect(result.urls.web).toBe("https://beutl-web-pr-229.preview-account.workers.dev");
    expect(result.config.services.map((binding) => binding.service)).toEqual(["beutl-ai-images-pr-229", "beutl-web-pr-229"]);
    expect(result.config.hyperdrive[0].id).toBe(input.hyperdriveId);
    expect(result.config.r2_buckets.map((binding) => binding.bucket_name)).toEqual([input.r2Bucket]);
    expect(result.config.triggers.crons).toEqual([]);
    expect(result.config.routes).toEqual([]);
    expect(result.config.assets.directory).toBe("/workspace/apps/web/.open-next/assets");
    expect(result.config.vars.BETTER_AUTH_COOKIE_DOMAIN).toBe("");
    expect(web).toEqual(snapshot);
  });

  it("requires explicit opt-in before sharing production data", () => {
    const shared = { ...settings(), hyperdriveId: base.hyperdrive[0].id, r2Bucket: base.r2_buckets[0].bucket_name };
    expect(() => previewConfig(base, "image-worker", "229", "preview-account", shared, "/workspace/apps/image-worker")).toThrow("dedicated preview data");
    expect(previewConfig(base, "image-worker", "229", "preview-account", { ...shared, allowProductionData: true }, "/workspace/apps/image-worker").config.hyperdrive[0].id).toBe(shared.hyperdriveId);
  });

  it("rejects mismatched authentication and secret-backed origin overrides", () => {
    const mismatched = structuredClone(input);
    mismatched.secrets.admin.BETTER_AUTH_SECRET = "different";
    expect(() => parsePreviewInput(JSON.stringify(mismatched))).toThrow("same BETTER_AUTH_SECRET");
    const overridden = structuredClone(input);
    Object.assign(overridden.secrets.web, { PUBLIC_ORIGIN: "https://production.example" });
    expect(() => parsePreviewInput(JSON.stringify(overridden))).toThrow("reserved setting");
  });
});
