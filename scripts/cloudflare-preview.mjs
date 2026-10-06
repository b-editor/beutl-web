import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const apps = ["image-worker", "web", "admin"];
const prefixes = { web: "beutl-web", admin: "beutl-admin", "image-worker": "beutl-ai-images" };
const generatedVars = new Set([
  "PUBLIC_ORIGIN", "BETTER_AUTH_URL", "METADATA_BASE_URL", "BETTER_AUTH_RP_ID",
  "BETTER_AUTH_COOKIE_DOMAIN", "BEUTL_STORAGE_PROVIDER",
]);

export function previewNames(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error("PR_NUMBER must be a positive integer.");
  }
  return Object.fromEntries(apps.map((app) => [app, `${prefixes[app]}-pr-${value}`]));
}

export function parsePreviewInput(text) {
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error("Set CLOUDFLARE_PREVIEW_CONFIG to valid preview configuration JSON.");
  }
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    !/^[a-f0-9]{32}$/i.test(input.hyperdriveId ?? "") ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.r2Bucket ?? "") ||
    (input.allowProductionData !== undefined && typeof input.allowProductionData !== "boolean")) {
    throw new Error("Preview configuration requires hyperdriveId and r2Bucket.");
  }
  const secrets = {};
  for (const app of apps) {
    const values = input.secrets?.[app] ?? {};
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error(`Preview secrets for ${app} must be a string map.`);
    }
    for (const [key, value] of Object.entries(values)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || generatedVars.has(key) ||
        typeof value !== "string" || value.length === 0) {
        throw new Error(`Preview secrets for ${app} contain an invalid or reserved setting.`);
      }
    }
    secrets[app] = { ...values };
  }
  for (const key of ["BETTER_AUTH_SECRET", "JWT_SECRET", "AI_IMAGE_WORKER_JWT_SECRET"]) {
    if (!secrets.web[key]) throw new Error(`Preview Web secrets require ${key}.`);
  }
  if (secrets.admin.BETTER_AUTH_SECRET !== secrets.web.BETTER_AUTH_SECRET) {
    throw new Error("Preview Web and Admin must use the same BETTER_AUTH_SECRET.");
  }
  secrets["image-worker"].JWT_SECRET ??= secrets.web.AI_IMAGE_WORKER_JWT_SECRET;
  if (secrets["image-worker"].JWT_SECRET !== secrets.web.AI_IMAGE_WORKER_JWT_SECRET) {
    throw new Error("Preview image Worker JWT_SECRET must match Web AI_IMAGE_WORKER_JWT_SECRET.");
  }
  return { ...input, secrets };
}

export function previewConfig(base, app, number, subdomain, input, appRoot) {
  const names = previewNames(number);
  if (!apps.includes(app) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
    throw new Error("Invalid preview app or workers.dev subdomain.");
  }
  const urls = Object.fromEntries(["web", "admin"].map((name) =>
    [name, `https://${names[name]}.${subdomain}.workers.dev`]
  ));
  const database = base.hyperdrive?.find((binding) => binding.binding === "BEUTL_DATABASE_HYPERDRIVE");
  const storage = base.r2_buckets?.find((binding) => binding.binding === "BEUTL_R2_BUCKET");
  if (!database || !storage) throw new Error(`Missing database or storage binding for ${app}.`);
  if (!input.allowProductionData &&
    (input.hyperdriveId === database.id || input.r2Bucket === storage.bucket_name)) {
    throw new Error("Use dedicated preview data, or explicitly set allowProductionData to true.");
  }
  const config = {
    ...structuredClone(base),
    name: names[app],
    main: resolve(appRoot, base.main),
    keep_vars: false,
    workers_dev: app !== "image-worker",
    preview_urls: false,
    routes: [],
    triggers: { crons: [] },
    hyperdrive: [{ ...database, id: input.hyperdriveId }],
    r2_buckets: [{ ...storage, bucket_name: input.r2Bucket }],
    vars: { ...base.vars, PUBLIC_ORIGIN: urls.web, BEUTL_STORAGE_PROVIDER: "r2" },
  };
  delete config.route;
  delete config.env;
  if (base.assets) config.assets = { ...base.assets, directory: resolve(appRoot, base.assets.directory) };
  if (app !== "image-worker") {
    Object.assign(config.vars, {
      BETTER_AUTH_URL: urls[app],
      METADATA_BASE_URL: urls[app],
      BETTER_AUTH_RP_ID: new URL(urls[app]).hostname,
      BETTER_AUTH_COOKIE_DOMAIN: "",
    });
  }
  config.services = (base.services ?? []).map((binding) => {
    if (binding.binding !== "AI_IMAGE_WORKER" && binding.binding !== "WORKER_SELF_REFERENCE") {
      throw new Error(`Unsupported preview service binding for ${app}.`);
    }
    return { ...binding, service: binding.binding === "AI_IMAGE_WORKER" ? names["image-worker"] : names[app] };
  });
  return { config, urls };
}

async function cloudflare(method, path, allowMissing = false) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !/^[a-f0-9]{32}$/i.test(account ?? "")) {
    throw new Error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID repository secrets.");
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (allowMissing && response.status === 404) return null;
  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(`Cloudflare ${method} request failed (HTTP ${response.status}).`);
  }
  return result.result;
}

async function prepare() {
  const input = parsePreviewInput(process.env.CLOUDFLARE_PREVIEW_CONFIG ?? "");
  const subdomain = process.env.PREVIEW_SUBDOMAIN ?? (await cloudflare("GET", "workers/subdomain")).subdomain;
  const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
  const typescript = require("typescript");
  const prepared = [];
  for (const app of apps) {
    const appRoot = resolve(root, "apps", app);
    const parsed = typescript.readConfigFile(resolve(appRoot, "wrangler.jsonc"), typescript.sys.readFile);
    if (parsed.error) throw new Error(`Unable to read Wrangler configuration for ${app}.`);
    prepared.push({ app, appRoot, ...previewConfig(parsed.config, app, process.env.PR_NUMBER, subdomain, input, appRoot) });
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    for (const values of Object.values(input.secrets)) {
      for (const value of Object.values(values)) {
        const escaped = value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
        process.stdout.write(`::add-mask::${escaped}\n`);
      }
    }
  }
  for (const { app, appRoot, config } of prepared) {
    const directory = resolve(appRoot, ".wrangler");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "ci-preview.json"), JSON.stringify(config, null, 2));
    await writeFile(resolve(directory, "ci-preview-secrets.json"), JSON.stringify(input.secrets[app]), { mode: 0o600 });
  }
  const { urls } = prepared[0];
  if (process.env.GITHUB_ENV) {
    await appendFile(process.env.GITHUB_ENV, `PREVIEW_WEB_URL=${urls.web}\nPREVIEW_ADMIN_URL=${urls.admin}\n`);
  }
  console.log(`Web preview: ${urls.web}\nAdmin preview: ${urls.admin}`);
}

async function summary() {
  previewNames(process.env.PR_NUMBER);
  const config = JSON.parse(await readFile(resolve(root, "apps/web/.wrangler/ci-preview.json"), "utf8"));
  const web = config.vars.BETTER_AUTH_URL;
  const admin = JSON.parse(await readFile(resolve(root, "apps/admin/.wrangler/ci-preview.json"), "utf8")).vars.BETTER_AUTH_URL;
  const markdown = `## PR #${process.env.PR_NUMBER} previews\n\n| App | URL |\n| --- | --- |\n| Web/API | [Open Web](${web}) |\n| Admin | [Open Admin](${admin}) |\n`;
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
}

async function cleanup() {
  const names = previewNames(process.env.PR_NUMBER);
  const owned = new Set(Object.values(names));
  for (const app of ["web", "admin", "image-worker"]) {
    const name = names[app];
    const references = await cloudflare("GET", `workers/scripts/${name}/references`, true);
    if (references === null) continue;
    const dependents = [...(references.services?.incoming ?? []), ...(references.durable_objects ?? [])];
    const tails = await cloudflare("GET", `workers/tails/by-consumer/${name}`);
    if (dependents.some((binding) => !owned.has(binding.service)) ||
      tails.some((tail) => !owned.has(tail.producer?.service ?? tail.producer?.script)) ||
      references.services?.pages_function || references.dispatch_outbounds?.length) {
      throw new Error(`Refusing to remove ${name}: a Worker outside this PR depends on it.`);
    }
    await cloudflare("DELETE", `workers/services/${name}?force=true`, true);
    console.log(`Removed ${name}.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const action = process.argv[2];
    if (action === "prepare") await prepare();
    else if (action === "summary") await summary();
    else if (action === "cleanup") await cleanup();
    else throw new Error("Usage: cloudflare-preview.mjs prepare|summary|cleanup");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Preview operation failed.");
    process.exitCode = 1;
  }
}
