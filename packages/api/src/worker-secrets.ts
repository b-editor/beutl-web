export interface SecretsStoreSecret {
  get(): Promise<string>;
}

// Explicit names keep R2, KV and other bindings with get() out of this path.
export const WORKER_SECRET_NAMES = [
  "BETTER_AUTH_SECRET", "AUTH_SECRET", "AUTH_GOOGLE_SECRET", "AUTH_GITHUB_SECRET",
  "AUTH_RESEND_KEY", "GITHUB_PAT", "IPINFO_TOKEN", "JWT_SECRET",
  "AI_IMAGE_WORKER_JWT_SECRET", "NUGET_DOWNLOAD_SECRET",
  "STRIPE_SECRET_KEY", "STRIPE_ENDPOINT_SECRET", "OPENROUTER_API_KEY",
  "OPENROUTER_WEBHOOK_SECRET", "VERCEL_AI_GATEWAY_API_KEY",
  "BEUTL_S3_ACCESS_KEY_ID", "BEUTL_S3_SECRET_ACCESS_KEY", "BEUTL_S3_SESSION_TOKEN",
  "GRAFANA_TEMPO_TOKEN", "GRAFANA_LOKI_TOKEN",
] as const;

type SecretName = typeof WORKER_SECRET_NAMES[number];
export type WorkerSecretBindings<Env> = {
  [Key in keyof Env]: Key extends SecretName ? Env[Key] | SecretsStoreSecret : Env[Key];
};

/** Resolve within each invocation: neither secret values nor in-flight I/O are cached. */
export async function resolveWorkerSecrets<Env extends object>(
  bindings: WorkerSecretBindings<Env>,
  names: readonly SecretName[] = WORKER_SECRET_NAMES,
): Promise<Env> {
  const source = bindings as Record<string, unknown>;
  const entries = await Promise.all(names.map(async (name) => {
    const binding = source[name];
    if (binding === undefined || typeof binding === "string") return [name, binding] as const;
    try {
      if (binding === null || typeof binding !== "object" || !("get" in binding) ||
          typeof binding.get !== "function") throw new Error();
      let value: unknown;
      // A rejected RPC read can be transient. Retry only that binding, within
      // this invocation; do not reuse an old secret or cross-request promise.
      for (let attempt = 0; ; attempt++) {
        try {
          value = await binding.get();
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
        }
      }
      if (typeof value !== "string" || value.length === 0) throw new Error();
      return [name, value] as const;
    } catch {
      // Do not expose provider errors or continue with an old process.env value.
      throw new Error(`Unable to resolve Secrets Store binding ${name}`);
    }
  }));
  const resolved = entries.some(([name, value]) => source[name] !== value)
    ? { ...source } : source;
  // Commit only after every binding succeeded. OpenNext initializes process.env
  // once, so refresh secrets here on subsequent requests as well.
  for (const [name, value] of entries) {
    if (value !== undefined) {
      if (source[name] !== value) resolved[name] = value;
      process.env[name] = value;
    }
  }
  return resolved as Env;
}
