// The Worker runtime module. vinext runs server code inside workerd, where
// `env` holds the bindings declared in wrangler.jsonc.
declare module "cloudflare:workers" {
  export const env: CloudflareEnv;
  export function waitUntil(promise: Promise<unknown>): void;
}
