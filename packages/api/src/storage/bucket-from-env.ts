// 環境変数からオブジェクトストレージの実装を選ぶ。既定は Cloudflare R2 の
// バインディング (BEUTL_R2_BUCKET)。BEUTL_STORAGE_PROVIDER=s3 なら S3 互換
// ストレージへ SigV4 署名付き HTTP でアクセスする。Web (OpenNext) と API
// Worker の両方がここを通るので、設定の読み方はこの 1 か所に閉じる。
import type { R2BucketLike } from "../ai/r2-provider";
import { createLayeredBucket } from "./layered-bucket";
import { createS3CompatibleBucket } from "./s3-compatible-bucket";

export const STORAGE_PROVIDERS = ["r2", "s3"] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

/** One configured store: the provider name, its bucket, and a label an
 * administrator can recognise it by (never a credential). */
export type StorageStore = {
  provider: StorageProvider;
  bucket: R2BucketLike;
  label: string;
};

export type StorageStores = {
  /** Where new objects are written. */
  primary: StorageProvider;
  /** Every configured store, primary first. */
  stores: StorageStore[];
};

const STORAGE_PROVIDER_KEY = "BEUTL_STORAGE_PROVIDER";
const R2_BINDING_KEY = "BEUTL_R2_BUCKET";
const S3_KEYS = {
  endpoint: "BEUTL_S3_ENDPOINT",
  bucket: "BEUTL_S3_BUCKET",
  region: "BEUTL_S3_REGION",
  accessKeyId: "BEUTL_S3_ACCESS_KEY_ID",
  secretAccessKey: "BEUTL_S3_SECRET_ACCESS_KEY",
  sessionToken: "BEUTL_S3_SESSION_TOKEN",
  forcePathStyle: "BEUTL_S3_FORCE_PATH_STYLE",
} as const;

// Worker の vars/secrets は env に、`next dev` の .env は process.env にしか
// 無いので両方を見る。env が優先。
function readString(env: object, key: string): string | undefined {
  const bound = (env as Record<string, unknown>)[key];
  const value = typeof bound === "string" ? bound : process.env[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireString(env: object, key: string): string {
  const value = readString(env, key);
  if (value === undefined) {
    throw new Error(`${key} is required for S3 compatible storage`);
  }
  return value;
}

function readBoolean(env: object, key: string, fallback: boolean): boolean {
  const value = readString(env, key)?.toLowerCase();
  if (value === undefined) return fallback;
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error(`${key} must be true or false, received "${value}"`);
}

export function storageProviderOf(env: object): StorageProvider {
  const value = readString(env, STORAGE_PROVIDER_KEY)?.toLowerCase() ?? "r2";
  if ((STORAGE_PROVIDERS as readonly string[]).includes(value)) {
    return value as StorageProvider;
  }
  throw new Error(
    `${STORAGE_PROVIDER_KEY} must be one of ${STORAGE_PROVIDERS.join(", ")}, received "${value}"`,
  );
}

function r2Binding(env: object): R2BucketLike | undefined {
  const binding = (env as Record<string, unknown>)[R2_BINDING_KEY];
  return binding && typeof binding === "object" ? (binding as R2BucketLike) : undefined;
}

function s3Configured(env: object): boolean {
  return Object.values(S3_KEYS).some((key) => readString(env, key) !== undefined);
}

function s3Bucket(env: object): R2BucketLike {
  return createS3CompatibleBucket({
    endpoint: requireString(env, S3_KEYS.endpoint),
    bucket: requireString(env, S3_KEYS.bucket),
    region: readString(env, S3_KEYS.region),
    accessKeyId: requireString(env, S3_KEYS.accessKeyId),
    secretAccessKey: requireString(env, S3_KEYS.secretAccessKey),
    sessionToken: readString(env, S3_KEYS.sessionToken),
    forcePathStyle: readBoolean(env, S3_KEYS.forcePathStyle, true),
  });
}

/** Which providers the configuration describes, primary first. */
export function configuredStorageProviders(env: object): StorageProvider[] {
  const primary = storageProviderOf(env);
  const other: StorageProvider = primary === "r2" ? "s3" : "r2";
  const otherConfigured = other === "r2" ? r2Binding(env) !== undefined : s3Configured(env);
  return otherConfigured ? [primary, other] : [primary];
}

function buildStore(env: object, provider: StorageProvider): StorageStore {
  if (provider === "s3") {
    const endpoint = new URL(requireString(env, S3_KEYS.endpoint));
    return {
      provider,
      bucket: s3Bucket(env),
      label: `S3 (${endpoint.host}/${requireString(env, S3_KEYS.bucket)})`,
    };
  }
  const binding = r2Binding(env);
  if (!binding) {
    throw new Error(
      `${R2_BINDING_KEY} binding not found; set ${STORAGE_PROVIDER_KEY}=s3 to use S3 compatible storage instead`,
    );
  }
  return { provider, bucket: binding, label: `R2 (${R2_BINDING_KEY})` };
}

/**
 * Every store the configuration describes, primary first. A provider that is
 * named but incomplete throws, so a misconfiguration surfaces on the first
 * storage call rather than as a quiet miss.
 */
export function createStorageStores(env: object): StorageStores {
  const providers = configuredStorageProviders(env);
  return {
    primary: providers[0],
    stores: providers.map((provider) => buildStore(env, provider)),
  };
}

const resolvedStores = new WeakMap<object, StorageStores>();

export function resolveStorageStores(env: object): StorageStores {
  const cached = resolvedStores.get(env);
  if (cached) return cached;
  const stores = createStorageStores(env);
  resolvedStores.set(env, stores);
  return stores;
}

/**
 * Build the bucket the configuration names. New objects go to the provider
 * `BEUTL_STORAGE_PROVIDER` selects. When the other provider is configured as
 * well, objects the primary does not hold are read from it, so switching
 * providers keeps what was stored before the switch reachable without a copy.
 */
export function createStorageBucket(env: object): R2BucketLike {
  const { stores } = createStorageStores(env);
  const [primary, fallback] = stores;
  return fallback === undefined
    ? primary.bucket
    : createLayeredBucket({ primary: primary.bucket, fallback: fallback.bucket });
}

const resolved = new WeakMap<object, R2BucketLike>();

/**
 * The bucket for one Worker env, built once per env object. A signing client
 * caches its derived keys, so handing out the same instance keeps every
 * request from re-deriving them.
 */
export function resolveStorageBucket(env: object): R2BucketLike {
  const cached = resolved.get(env);
  if (cached) return cached;
  const bucket = createStorageBucket(env);
  resolved.set(env, bucket);
  return bucket;
}
