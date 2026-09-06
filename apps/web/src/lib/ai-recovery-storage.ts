import type { PersistedAiRecoveryEntry } from "./ai-screen";

export type AiRecoveryLockManager = {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => T | Promise<T>,
  ): Promise<T>;
};

/**
 * Allocate one digest identity under the caller's account/operation Web Lock.
 * Sharing that lock across digests serializes both identity and capacity. The caller owns
 * storage parsing/GC so this helper can be tested without React or a DOM.
 */
export async function acquireAiRecoveryEntry({
  lockName,
  digest,
  model,
  capability,
  readEntries,
  writeEntry,
  createKey,
  locks,
  maxEntries = 64,
}: {
  lockName: string;
  digest: string;
  model: string;
  capability: unknown | null;
  readEntries: () => readonly PersistedAiRecoveryEntry[];
  writeEntry: (entry: PersistedAiRecoveryEntry) => boolean;
  createKey: () => string;
  locks: AiRecoveryLockManager | undefined;
  maxEntries?: number;
}): Promise<PersistedAiRecoveryEntry | null> {
  const existing = readEntries().find((entry) => entry.digest === digest);
  if (existing) return existing;
  if (!locks) return null;
  return locks.request(lockName, { mode: "exclusive" }, () => {
    const raced = readEntries().find((entry) => entry.digest === digest);
    if (raced) return raced;
    if (readEntries().length >= maxEntries) return null;
    const entry: PersistedAiRecoveryEntry = {
      digest,
      key: createKey(),
      model,
      capability,
      updatedAt: Date.now(),
    };
    return writeEntry(entry) ? entry : null;
  });
}
