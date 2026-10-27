import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const requireApp = createRequire(resolve("package.json"));
const { unstable_dev, experimental_readRawConfig } = requireApp("wrangler");
const requireWrangler = createRequire(requireApp.resolve("wrangler"));
const { Miniflare, convertV4MiniflareOptions } = requireWrangler("miniflare");

// Use the generated OpenNext Worker, not the adapter stub used by unit tests.
// These unauthenticated pages need no database or production credentials.
process.env.WRANGLER_SEND_METRICS = "false";
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_BEUTL_DATABASE_HYPERDRIVE =
  "postgresql://unused:unused@127.0.0.1:1/unused";
const persistTo = await mkdtemp(join(tmpdir(), "beutl-next-runtime-"));
let worker;
try {
  const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });
  const secrets = rawConfig.secrets_store_secrets ?? [];
  const seed = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: "export default { fetch() { return new Response(null); } }",
    resourcePersistencePath: join(persistTo, "v3"),
    secretsStoreSecrets: Object.fromEntries(secrets.map(({ binding, ...secret }) => [binding, secret])),
  }));
  try {
    for (const { binding } of secrets) {
      const api = (await seed.getSecretsStoreSecretAPI(binding))();
      await api.create(`worker-runtime-check-only-${binding}`);
    }
  } finally { await seed.dispose(); }

  worker = await unstable_dev("worker.js", {
    config: "wrangler.jsonc",
    local: true,
    port: 0,
    inspectorPort: 0,
    persist: true,
    persistTo,
    logLevel: "error",
    vars: {
      BETTER_AUTH_URL: "https://validation.example.com",
      METADATA_BASE_URL: "https://validation.example.com",
    },
    experimental: {
      disableExperimentalWarning: true,
      watch: false,
    },
  });
  const pages = [
    ["/en/account/verify-request", "Check your email"],
    ["/en/account/sign-in", 'name="email"'],
  ];
  if (rawConfig.name === "beutl-web") {
    const preview = `/preview/${"a".repeat(64)}/00000000-0000-0000-0000-000000000001`;
    pages.push([preview, 'id="viewer"'], [`/en${preview}`, 'aria-label="Mobile preview"']);
  }
  for (const [path, expected] of pages) {
    const response = await worker.fetch(path, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const html = await response.text();
    assert.equal(response.status, 200, `${path}: ${html.slice(0, 1500)}`);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    assert.ok(html.includes(expected), `${path}: missing rendered page content; labels: ${html.match(/aria-label="[^"]*"/gu)?.join(", ")}`);
    assert.ok(!html.includes('id="__next_error__"'), `${path}: Next.js rendered an error`);
    console.log(`Worker rendered ${path} successfully.`);
  }
} finally {
  await worker?.stop();
  await rm(persistTo, { recursive: true, force: true });
}
