import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const requireApp = createRequire(resolve("package.json"));
const { unstable_dev } = requireApp("wrangler");

// Use the generated OpenNext Worker, not the adapter stub used by unit tests.
// These unauthenticated pages need no database or production credentials.
process.env.WRANGLER_SEND_METRICS = "false";
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_BEUTL_DATABASE_HYPERDRIVE =
  "postgresql://unused:unused@127.0.0.1:1/unused";
const worker = await unstable_dev("worker.js", {
  config: "wrangler.jsonc",
  local: true,
  port: 0,
  inspectorPort: 0,
  persist: false,
  logLevel: "error",
  vars: {
    BETTER_AUTH_SECRET: "worker-runtime-check-only-not-a-production-secret",
    BETTER_AUTH_URL: "https://validation.example.com",
    METADATA_BASE_URL: "https://validation.example.com",
  },
  experimental: {
    disableExperimentalWarning: true,
    watch: false,
  },
});
try {
  for (const [path, expected] of [
    ["/en/account/verify-request", "Check your email"],
    ["/en/account/sign-in", 'name="email"'],
  ]) {
    const response = await worker.fetch(path, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const html = await response.text();
    assert.equal(response.status, 200, `${path}: ${html.slice(0, 1500)}`);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    assert.ok(html.includes(expected), `${path}: missing rendered page content`);
    assert.ok(!html.includes('id="__next_error__"'), `${path}: Next.js rendered an error`);
    console.log(`Worker rendered ${path} successfully.`);
  }
} finally {
  await worker.stop();
}
