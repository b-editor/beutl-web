import type { PrismaClient } from "@prisma/client";

// ランタイム環境 (Next.js/Cloudflare OpenNext, 独立 Worker など) ごとに
// PrismaClient の生成方法を注入する。デフォルトは未設定で、getDb() はエラーを投げる。
// 各アプリは起動時に setDbProvider() を呼ぶこと。
//
// NOTE: A provider may memoize within one request, but Cloudflare request-bound
// I/O must never be retained in an isolate-global client.
// NOTE: provider はモジュールスコープではなく globalThis に保持する。
// Next.js (特に dev の Turbopack) は instrumentation と SSR で別々にバンドルするため、
// モジュール変数だと setDbProvider() と getDb() が別インスタンスを参照してしまい
// "Db provider is not set" になる。
const GLOBAL_KEY = "__BEUTL_DB_PROVIDER__";
export const DB_PROVIDER_SCOPE_GLOBAL_KEY = "__BEUTL_DB_PROVIDER_SCOPE__";

export type DbProvider = () => Promise<PrismaClient>;
export type DbProviderScopeState = {
  provider: DbProvider;
  clientPromise: Promise<PrismaClient> | null;
  pendingTasks: Set<Promise<void>>;
  releaseClient?: () => Promise<void>;
  closed: boolean;
};

export function getConfiguredDbProvider(): DbProvider {
  const provider = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as
    | DbProvider
    | undefined;
  if (!provider) {
    throw new Error(
      "Db provider is not set. Call setDbProvider() before using @beutl/db.",
    );
  }
  return provider;
}

function getCurrentProviderScope(): DbProviderScopeState | undefined {
  const storage = (globalThis as Record<string, unknown>)[
    DB_PROVIDER_SCOPE_GLOBAL_KEY
  ] as
    | { getStore(): DbProviderScopeState | undefined }
    | undefined;
  return storage?.getStore();
}

export function setDbProvider(fn: () => Promise<PrismaClient>): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = fn;
}

export async function getDb(): Promise<PrismaClient> {
  const scope = getCurrentProviderScope();
  if (scope) {
    if (scope.closed) {
      throw new Error("The request-scoped Db provider is already closed.");
    }
    // Store the Promise before awaiting it so concurrent callers share both a
    // successful client and a factory rejection.
    scope.clientPromise ??= Promise.resolve().then(scope.provider);
    return scope.clientPromise;
  }

  return getConfiguredDbProvider()();
}

export function hasDbProviderScope(): boolean {
  return getCurrentProviderScope() !== undefined;
}

/**
 * Adopts detached work that may still use the current request's database
 * client. The scope will not disconnect until every adopted task settles.
 */
export function trackDbProviderScopeTask<T>(task: Promise<T>): Promise<T> {
  const scope = getCurrentProviderScope();
  if (!scope || scope.closed) return task;

  const settlement = task.then(
    () => undefined,
    () => undefined,
  );
  scope.pendingTasks.add(settlement);
  void settlement.finally(() => scope.pendingTasks.delete(settlement));
  return task;
}

export type { PrismaClient } from "@prisma/client";
