import { describe, expect, it } from "vitest";
import {
  getOrCreateStoredRetryAttempt,
  removeStoredRetryAttempt,
  retryJobFingerprint,
  readStoredRetryAttempt,
  retryAttemptStorageKey,
  updateStoredRetryAttempt,
} from "../../apps/web/src/lib/ai-retry-attempt";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function serialLocks() {
  let tail = Promise.resolve();
  return {
    request: async <T>(
      _name: string,
      _options: { mode: "exclusive" },
      callback: () => T | Promise<T>,
    ): Promise<T> => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { return await callback(); } finally { release(); }
    },
  };
}

describe("AI history retry attempt persistence", () => {
  it("allocates one key for two simultaneous tabs", async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    let generation = 0;
    const create = () => getOrCreateStoredRetryAttempt({
      storage,
      locks,
      userId: "user",
      jobId: "job",
      expectedPayload: "payload",
      createKey: () => `key-${++generation}`,
    });

    const [first, second] = await Promise.all([create(), create()]);

    expect(first?.idempotencyKey).toBe("key-1");
    expect(second).toEqual(first);
    expect(generation).toBe(1);
  });

  it("fails closed without locks unless a durable key already exists", async () => {
    const storage = memoryStorage();
    const missing = await getOrCreateStoredRetryAttempt({
      storage,
      locks: undefined,
      userId: "user",
      jobId: "job",
      expectedPayload: "payload",
      createKey: () => "unsafe-new-key",
    });
    expect(missing).toBeNull();

    storage.setItem(retryAttemptStorageKey("user", "job"), JSON.stringify({
      jobId: "job",
      idempotencyKey: "existing-key",
      expectedPayload: "payload",
      state: "submitting",
    }));
    const existing = await getOrCreateStoredRetryAttempt({
      storage,
      locks: undefined,
      userId: "user",
      jobId: "job",
      expectedPayload: "payload",
      createKey: () => "unused",
    });
    expect(existing).toMatchObject({ idempotencyKey: "existing-key", state: "ambiguous" });
  });

  it("isolates accounts and rejects malformed persisted attempts", () => {
    const storage = memoryStorage();
    storage.setItem(retryAttemptStorageKey("a", "job"), JSON.stringify({
      jobId: "job",
      idempotencyKey: "key-a",
      expectedPayload: "payload",
      state: "ambiguous",
    }));
    storage.setItem(retryAttemptStorageKey("b", "job"), "{broken");

    expect(readStoredRetryAttempt(storage, "a", "job")?.idempotencyKey).toBe("key-a");
    expect(readStoredRetryAttempt(storage, "b", "job")).toBeNull();
  });

  it("stores a canonical digest instead of the prompt payload", async () => {
    const fingerprint = await retryJobFingerprint({
      kind: "image",
      model: "model-a",
      inputParams: { prompt: "secret prompt", aspectRatio: "1:1" },
    });
    const reordered = await retryJobFingerprint({
      kind: "image",
      model: "model-a",
      inputParams: { aspectRatio: "1:1", prompt: "secret prompt" },
    });
    expect(reordered).toBe(fingerprint);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    const storage = memoryStorage();
    const locks = serialLocks();
    const attempt = await getOrCreateStoredRetryAttempt({
      storage,
      locks,
      userId: "user",
      jobId: "job",
      expectedFingerprint: fingerprint,
      createKey: () => "key",
    });
    expect(storage.values.get(retryAttemptStorageKey("user", "job"))).not.toContain("secret prompt");
    expect(attempt?.expectedFingerprint).toBe(fingerprint);
  });

  it("rejects stale K1 updates and removals after K2 replaces the slot", async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    const f1 = "1".repeat(64);
    const f2 = "2".repeat(64);
    storage.setItem(retryAttemptStorageKey("user", "job"), JSON.stringify({
      jobId: "job", idempotencyKey: "key-2", expectedFingerprint: f2, state: "ambiguous",
    }));
    const stale = {
      jobId: "job", idempotencyKey: "key-1", expectedFingerprint: f1, state: "ambiguous" as const,
    };
    await expect(updateStoredRetryAttempt({
      storage, locks, userId: "user", attempt: stale, expectedKey: "key-1",
    })).resolves.toBe(false);
    await expect(removeStoredRetryAttempt({
      storage, locks, userId: "user", jobId: "job", expectedKey: "key-1", expectedFingerprint: f1,
    })).resolves.toBe(false);
    expect(readStoredRetryAttempt(storage, "user", "job")).toMatchObject({
      idempotencyKey: "key-2", expectedFingerprint: f2,
    });
  });

  it("recovers an ambiguous response after a reload using the same key", async () => {
    const storage = memoryStorage();
    const locks = serialLocks();
    const fingerprint = "a".repeat(64);
    const first = await getOrCreateStoredRetryAttempt({
      storage, locks, userId: "user", jobId: "job", expectedFingerprint: fingerprint,
      createKey: () => "key-1",
    });
    expect(first?.idempotencyKey).toBe("key-1");
    await updateStoredRetryAttempt({
      storage, locks, userId: "user",
      attempt: { ...first!, state: "submitting" }, expectedKey: "key-1",
    });
    const restored = readStoredRetryAttempt(storage, "user", "job");
    expect(restored).toMatchObject({ idempotencyKey: "key-1", state: "ambiguous" });
  });
});
