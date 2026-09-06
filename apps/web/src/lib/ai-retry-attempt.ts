export type StoredAiRetryAttempt = {
  jobId: string;
  idempotencyKey: string;
  /** SHA-256 of the canonical (kind, model, inputParams) snapshot. */
  expectedFingerprint: string;
  state: "confirming" | "submitting" | "ambiguous";
  /** Legacy-only field, never written by the current implementation. */
  expectedPayload?: string;
};

type RetryAttemptStorage = {
  getItem: Storage["getItem"];
  setItem: Storage["setItem"];
  removeItem?: Storage["removeItem"];
};

type ExclusiveLockManager = {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => T | Promise<T>,
  ): Promise<T>;
};

const RETRY_ATTEMPT_STORAGE_PREFIX = "beutl.ai.retry-attempt.v1";

export function retryAttemptStorageKey(userId: string, jobId: string): string {
  return `${RETRY_ATTEMPT_STORAGE_PREFIX}.${encodeURIComponent(userId)}.${encodeURIComponent(jobId)}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalRetryPayload({
  kind,
  model,
  inputParams,
}: {
  kind: string;
  model: string | null | undefined;
  inputParams: unknown;
}): string {
  return JSON.stringify(canonicalize({
    kind,
    model: model ?? null,
    inputParams,
  }));
}

export async function retryJobFingerprint(payload: {
  kind: string;
  model: string | null | undefined;
  inputParams: unknown;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalRetryPayload(payload)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function fingerprintText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

export function readStoredRetryAttempt(
  storage: Pick<Storage, "getItem">,
  userId: string,
  jobId: string,
): StoredAiRetryAttempt | null {
  try {
    const raw = storage.getItem(retryAttemptStorageKey(userId, jobId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredAiRetryAttempt> & {
      expectedPayload?: unknown;
    };
    if (
      value.jobId !== jobId ||
      typeof value.idempotencyKey !== "string" ||
      value.idempotencyKey.length === 0 ||
      value.idempotencyKey.length > 255 ||
      !/^[\x20-\x7e]+$/u.test(value.idempotencyKey) ||
      !["confirming", "submitting", "ambiguous"].includes(value.state ?? "")
    ) {
      return null;
    }
    const fingerprint = value.expectedFingerprint;
    const legacyPayload = value.expectedPayload;
    if (
      !isFingerprint(fingerprint) &&
      (typeof legacyPayload !== "string" ||
        legacyPayload.length === 0 ||
        legacyPayload.length > 128 * 1024)
    ) {
      return null;
    }
    return {
      jobId,
      idempotencyKey: value.idempotencyKey,
      expectedFingerprint: isFingerprint(fingerprint) ? fingerprint : "",
      ...(isFingerprint(fingerprint) ? {} : { expectedPayload: legacyPayload }),
      state: value.state === "submitting" ? "ambiguous" : value.state!,
    };
  } catch {
    return null;
  }
}

async function migrateLegacyAttempt(
  storage: RetryAttemptStorage,
  locks: ExclusiveLockManager | undefined,
  attempt: StoredAiRetryAttempt,
  userId: string,
): Promise<StoredAiRetryAttempt> {
  if (attempt.expectedFingerprint || !attempt.expectedPayload) return attempt;
  let fingerprint = "";
  try {
    const parsed = JSON.parse(attempt.expectedPayload) as {
      kind?: unknown;
      model?: unknown;
      inputParams?: unknown;
    };
    if (typeof parsed.kind === "string") {
      fingerprint = await retryJobFingerprint({
        kind: parsed.kind,
        model: typeof parsed.model === "string" ? parsed.model : null,
        inputParams: parsed.inputParams,
      });
    }
  } catch {
    // A few pre-fingerprint test/development records used an opaque token
    // rather than the JSON payload. Hash that bounded token for migration.
    fingerprint = await fingerprintText(attempt.expectedPayload);
  }
  if (!fingerprint) return attempt;
  const migrated: StoredAiRetryAttempt = {
    jobId: attempt.jobId,
    idempotencyKey: attempt.idempotencyKey,
    expectedFingerprint: fingerprint,
    state: attempt.state,
  };
  const write = () => {
    const current = readStoredRetryAttempt(storage, userId, attempt.jobId);
    if (!current || current.idempotencyKey !== attempt.idempotencyKey) return false;
    try {
      storage.setItem(
        retryAttemptStorageKey(userId, attempt.jobId),
        JSON.stringify(migrated),
      );
      return true;
    } catch {
      return false;
    }
  };
  if (locks) {
    await locks.request(
      `beutl.ai.retry-attempt.${userId}.${attempt.jobId}`,
      { mode: "exclusive" },
      write,
    );
  }
  return migrated;
}

/**
 * Atomically allocate one paid retry identity across tabs. Without Web Locks,
 * an already-persisted attempt remains usable, but a new one fails closed:
 * two tabs minting different keys is a possible double charge.
 */
export async function getOrCreateStoredRetryAttempt({
  storage,
  locks,
  userId,
  jobId,
  expectedFingerprint,
  expectedPayload,
  createKey,
}: {
  storage: RetryAttemptStorage;
  locks: ExclusiveLockManager | undefined;
  userId: string;
  jobId: string;
  expectedFingerprint?: string;
  /** Compatibility input for callers written before fingerprint migration. */
  expectedPayload?: string;
  createKey: () => string;
}): Promise<StoredAiRetryAttempt | null> {
  const existing = readStoredRetryAttempt(storage, userId, jobId);
  if (existing) return migrateLegacyAttempt(storage, locks, existing, userId);
  if (!locks) return null;

  let fingerprint = expectedFingerprint;
  if (!isFingerprint(fingerprint) && expectedPayload) {
    try {
      const parsed = JSON.parse(expectedPayload) as {
        kind?: unknown;
        model?: unknown;
        inputParams?: unknown;
      };
      fingerprint = typeof parsed.kind === "string"
        ? await retryJobFingerprint({
            kind: parsed.kind,
            model: typeof parsed.model === "string" ? parsed.model : null,
            inputParams: parsed.inputParams,
          })
        : "";
    } catch {
      fingerprint = await fingerprintText(expectedPayload);
    }
  }
  if (!isFingerprint(fingerprint)) return null;

  return await locks.request(
    `beutl.ai.retry-attempt.${userId}.${jobId}`,
    { mode: "exclusive" },
    () => {
      const raced = readStoredRetryAttempt(storage, userId, jobId);
      if (raced) return raced;
      const created: StoredAiRetryAttempt = {
        jobId,
        idempotencyKey: createKey(),
        expectedFingerprint: fingerprint!,
        state: "confirming",
      };
      try {
        const key = retryAttemptStorageKey(userId, jobId);
        storage.setItem(key, JSON.stringify(created));
        const persisted = readStoredRetryAttempt(storage, userId, jobId);
        return persisted?.idempotencyKey === created.idempotencyKey
          ? persisted
          : null;
      } catch {
        return null;
      }
    },
  );
}

/** Update only the generation currently held by this tab. */
export async function updateStoredRetryAttempt({
  storage,
  locks,
  userId,
  attempt,
  expectedKey,
}: {
  storage: RetryAttemptStorage;
  locks: ExclusiveLockManager | undefined;
  userId: string;
  attempt: StoredAiRetryAttempt;
  expectedKey?: string;
}): Promise<boolean> {
  if (!isFingerprint(attempt.expectedFingerprint)) return false;
  const run = () => {
    const current = readStoredRetryAttempt(storage, userId, attempt.jobId);
    if (
      expectedKey !== undefined &&
      (!current || current.idempotencyKey !== expectedKey)
    ) return false;
    if (
      expectedKey === undefined &&
      current &&
      current.idempotencyKey !== attempt.idempotencyKey
    ) return false;
    try {
      storage.setItem(
        retryAttemptStorageKey(userId, attempt.jobId),
        JSON.stringify(attempt),
      );
      const persisted = readStoredRetryAttempt(storage, userId, attempt.jobId);
      return persisted?.idempotencyKey === attempt.idempotencyKey &&
        persisted.expectedFingerprint === attempt.expectedFingerprint;
    } catch {
      return false;
    }
  };
  if (!locks) return false;
  return locks.request(
    `beutl.ai.retry-attempt.${userId}.${attempt.jobId}`,
    { mode: "exclusive" },
    run,
  );
}

/** Remove only the exact generation that a caller still owns. */
export async function removeStoredRetryAttempt({
  storage,
  locks,
  userId,
  jobId,
  expectedKey,
  expectedFingerprint,
}: {
  storage: RetryAttemptStorage;
  locks: ExclusiveLockManager | undefined;
  userId: string;
  jobId: string;
  expectedKey: string;
  expectedFingerprint: string;
}): Promise<boolean> {
  const run = () => {
    const current = readStoredRetryAttempt(storage, userId, jobId);
    if (
      !current ||
      current.idempotencyKey !== expectedKey ||
      (current.expectedFingerprint !== expectedFingerprint &&
        !current.expectedPayload)
    ) return false;
    try {
      if (!storage.removeItem) return false;
      storage.removeItem(retryAttemptStorageKey(userId, jobId));
      return readStoredRetryAttempt(storage, userId, jobId) === null;
    } catch {
      return false;
    }
  };
  if (!locks) return false;
  return locks.request(
    `beutl.ai.retry-attempt.${userId}.${jobId}`,
    { mode: "exclusive" },
    run,
  );
}
