import type { PrismaClient } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";

// ランタイム環境 (Next.js/Cloudflare OpenNext, 独立 Worker など) ごとに
// PrismaClient の生成方法を注入する。デフォルトは未設定で、getDb() はエラーを投げる。
// 各アプリは起動時に setDbProvider() を呼ぶこと。
//
// NOTE: PrismaClient の memoization はしない。Hyperdrive は maxUses:1 の
// per-request 接続モデルのため、毎リクエスト新規生成を維持する。
// NOTE: provider はモジュールスコープではなく globalThis に保持する。
// Next.js (特に dev の Turbopack) は instrumentation と SSR で別々にバンドルするため、
// モジュール変数だと setDbProvider() と getDb() が別インスタンスを参照してしまい
// "Db provider is not set" になる。
const GLOBAL_KEY = "__BEUTL_DB_PROVIDER__";
const SCOPE_KEY = "__BEUTL_DB_PROVIDER_SCOPE__";

type DbProvider = () => Promise<PrismaClient>;

function providerScope(): AsyncLocalStorage<DbProvider> {
  const global = globalThis as Record<string, unknown>;
  return (global[SCOPE_KEY] ??= new AsyncLocalStorage<DbProvider>()) as AsyncLocalStorage<DbProvider>;
}

/** Bind a provider to one scheduled invocation without changing concurrent requests. */
export function runWithDbProvider<T>(fn: DbProvider, callback: () => Promise<T>): Promise<T> {
  return providerScope().run(fn, callback);
}

export function setDbProvider(fn: () => Promise<PrismaClient>): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = fn;
}

export async function getDb(): Promise<PrismaClient> {
  const provider = (providerScope().getStore() ?? (globalThis as Record<string, unknown>)[GLOBAL_KEY]) as
    | DbProvider
    | undefined;
  if (!provider) {
    throw new Error(
      "Db provider is not set. Call setDbProvider() before using @beutl/db.",
    );
  }
  return provider();
}

export type { PrismaClient } from "@prisma/client";
