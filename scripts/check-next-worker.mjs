import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
  // An unminified bundle keeps its comments and cannot pass this check.
  if (rawConfig.minify) await assertOneByteBundle();
} finally {
  await worker?.stop();
  await rm(persistTo, { recursive: true, force: true });
}

/**
 * workerd copies the bundle onto the V8 heap, and a single character above
 * U+00FF makes V8 hold the whole source as UTF-16, at twice the bytes.
 * Minifying drops the comments and escapes string literals, but esbuild leaves
 * regular expression literals as written, so a dependency can still bring one.
 */
async function assertOneByteBundle() {
  const outdir = await mkdtemp(join(tmpdir(), "beutl-worker-bundle-"));
  try {
    const wrangler = join(dirname(requireApp.resolve("wrangler/package.json")), "bin", "wrangler.js");
    execFileSync(process.execPath, [wrangler, "deploy", "--dry-run", "--outdir", outdir, "--config", "wrangler.jsonc"], {
      // Otherwise wrangler hands an OpenNext project to `opennextjs-cloudflare deploy`.
      env: { ...process.env, OPEN_NEXT_DEPLOY: "true", WRANGLER_LOG: "error" },
      stdio: ["ignore", "ignore", "inherit"],
    });
    const source = await readFile(join(outdir, "worker.js"), "utf8");
    const size = `${(source.length / 1e6).toFixed(1)} MB`;
    const wide = [...source.matchAll(/[^\x00-\xff]/gu)];
    assert.equal(wide.length, 0, [
      `The ${size} Worker bundle has ${wide.length} characters above U+00FF, so V8 holds it as UTF-16:`,
      ...wide.slice(0, 5).map(({ 0: character, index }) =>
        `  U+${character.codePointAt(0).toString(16).toUpperCase()} in ...${source.slice(Math.max(0, index - 80), index + 20)}...`),
    ].join("\n"));
    console.log(`Worker bundle is ${size}, every character within U+00FF.`);
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
}
