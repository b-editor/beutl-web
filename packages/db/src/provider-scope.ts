import { AsyncLocalStorage } from "node:async_hooks";
import {
  DB_PROVIDER_SCOPE_GLOBAL_KEY,
  getConfiguredDbProvider,
  type DbProvider,
  type DbProviderScopeState,
  type PrismaClient,
} from "./provider";

type CleanupErrorHandler = (error: unknown) => void;
type WaitUntil = (promise: Promise<unknown>) => void;

export type DbProviderScope = {
  run<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult>;
  track<T>(task: Promise<T>): Promise<T>;
  dispose(): Promise<void>;
};

function getProviderScopeStorage(): AsyncLocalStorage<DbProviderScopeState> {
  const global = globalThis as Record<string, unknown>;
  let storage = global[DB_PROVIDER_SCOPE_GLOBAL_KEY] as
    | AsyncLocalStorage<DbProviderScopeState>
    | undefined;
  if (!storage) {
    storage = new AsyncLocalStorage<DbProviderScopeState>();
    global[DB_PROVIDER_SCOPE_GLOBAL_KEY] = storage;
  }
  return storage;
}

function reportCleanupError(error: unknown): void {
  console.error("Failed to disconnect request-scoped PrismaClient", error);
}

export function createDbProviderScope(
  provider: DbProvider,
  onCleanupError: CleanupErrorHandler = reportCleanupError,
): DbProviderScope {
  const state: DbProviderScopeState = {
    provider,
    clientPromise: null,
    pendingTasks: new Set(),
    closed: false,
  };
  const storage = getProviderScopeStorage();
  let disposal: Promise<void> | null = null;
  let release: Promise<void> | null = null;

  const releaseClient = (): Promise<void> => {
    release ??= (async () => {
      state.closed = true;
      const clientPromise = state.clientPromise;
      // The AsyncLocalStorage state can outlive an early release while a large
      // response streams. Drop its strong reference before awaiting cleanup.
      state.clientPromise = null;
      if (!clientPromise) return;

      // A rejected factory was already observed by getDb's caller. Await it
      // here only to settle the shared Promise; there is no client to clean.
      const client = await clientPromise.catch(() => null);
      if (!client) return;
      try {
        await client.$disconnect();
      } catch (error) {
        try {
          onCleanupError(error);
        } catch {
          // Reporting must never replace the request or scheduled result.
        }
      }
    })();
    return release;
  };
  state.releaseClient = releaseClient;

  return {
    async run<TResult>(
      operation: () => TResult | Promise<TResult>,
    ): Promise<TResult> {
      if (state.closed) {
        throw new Error("The request-scoped Db provider is already closed.");
      }
      return await storage.run(state, operation);
    },
    track<T>(task: Promise<T>): Promise<T> {
      if (state.closed) return task;
      const settlement = task.then(
        () => undefined,
        () => undefined,
      );
      state.pendingTasks.add(settlement);
      void settlement.finally(() => state.pendingTasks.delete(settlement));
      return task;
    },
    dispose(): Promise<void> {
      disposal ??= (async () => {
        // Detached producers may adopt further child tasks while settling.
        // Claim batches until the set is synchronously quiescent.
        while (state.pendingTasks.size > 0) {
          await Promise.all([...state.pendingTasks]);
        }
        await releaseClient();
      })();
      return disposal;
    },
  };
}

/** Runs a non-streaming operation and releases its request-local client. */
export async function runWithDbProviderScope<TResult>(
  provider: DbProvider,
  operation: () => TResult | Promise<TResult>,
  onCleanupError?: CleanupErrorHandler,
): Promise<TResult> {
  const scope = createDbProviderScope(provider, onCleanupError);
  try {
    return await scope.run(operation);
  } finally {
    await scope.dispose();
  }
}

/**
 * Returns a response without waiting for detached work, while keeping its
 * database scope alive until every explicitly adopted producer settles.
 */
export async function runWithDbProviderResponseScope(
  provider: DbProvider,
  operation: (waitUntil: WaitUntil) => Response | Promise<Response>,
  waitUntil?: WaitUntil,
): Promise<Response> {
  const scope = createDbProviderScope(provider);
  const scopedWaitUntil: WaitUntil = (task) => {
    scope.track(task);
    waitUntil?.(task);
  };
  let response: Response;
  try {
    response = await scope.run(() => operation(scopedWaitUntil));
  } catch (error) {
    const cleanup = scope.dispose();
    waitUntil?.(cleanup);
    void cleanup;
    throw error;
  }

  const cleanup = scope.dispose();
  waitUntil?.(cleanup);
  void cleanup;
  return response;
}

/**
 * Releases the current request's client before a long response body is sent.
 * Callers must have completed every database operation before using this.
 */
export async function releaseCurrentDbProviderClient(): Promise<void> {
  const state = getProviderScopeStorage().getStore();
  await state?.releaseClient?.();
}

function configuredProvider(): Promise<PrismaClient> {
  // Resolve lazily: Next.js may register its provider from instrumentation
  // after the outer Worker entrypoint has already opened this scope.
  return getConfiguredDbProvider()();
}

export async function runWithConfiguredDbProviderResponseScope(
  operation: (waitUntil: WaitUntil) => Response | Promise<Response>,
  waitUntil?: WaitUntil,
): Promise<Response> {
  return await runWithDbProviderResponseScope(
    configuredProvider,
    operation,
    waitUntil,
  );
}
