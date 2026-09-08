// プロバイダ間でオブジェクトを移す。File 行は objectKey しか持たず、どの
// ストアに実体があるかは HEAD で確かめる。移動は「コピー → 行き先を計測して
// 確認 → 元を削除」の順で、確認が取れるまで元には触らない。
import type { R2BucketLike } from "../ai/r2-provider";
import type { StorageProvider, StorageStore } from "./bucket-from-env";

export type ObjectLocation = {
  provider: StorageProvider;
  size: number | undefined;
};

export type MoveOutcome =
  | {
      kind: "moved";
      from: StorageProvider;
      to: StorageProvider;
      size: number;
      /** false when the copy succeeded but the source could not be deleted;
       * running the move again finishes the job. */
      sourceRemoved: boolean;
    }
  | { kind: "already-there"; to: StorageProvider; removedFrom: StorageProvider[] }
  | { kind: "missing" };

/**
 * Durable coordination the caller provides for one file. The lease is held
 * for the whole move so that moves of the same object in different isolates
 * cannot interleave; `stillExists` guards against the file being deleted
 * while the copy was in flight.
 */
export type StorageMoveLease = {
  acquire(): Promise<"acquired" | "busy" | "gone">;
  /** Verify this move still holds the lease and extend it. Asked right
   * before anything is deleted and periodically while a copy is in flight;
   * false means the lease expired or was taken, and nothing may be deleted. */
  confirm(): Promise<boolean>;
  stillExists(): Promise<boolean>;
  release(): Promise<void>;
};

// How often a copy in flight renews the lease it holds.
const LEASE_HEARTBEAT_MILLISECONDS = 60 * 1000;

export class StorageMoveError extends Error {
  readonly reason:
    | "no-destination"
    | "size-mismatch"
    | "verification-failed"
    | "contended"
    | "unsupported";

  constructor(reason: StorageMoveError["reason"], message: string) {
    super(message);
    this.name = "StorageMoveError";
    this.reason = reason;
  }
}

function inspector(store: StorageStore): NonNullable<R2BucketLike["head"]> {
  if (!store.bucket.head) {
    throw new StorageMoveError(
      "unsupported",
      `The ${store.provider} store cannot inspect objects`,
    );
  }
  return store.bucket.head.bind(store.bucket);
}

function remover(store: StorageStore): NonNullable<R2BucketLike["delete"]> {
  if (!store.bucket.delete) {
    throw new StorageMoveError(
      "unsupported",
      `The ${store.provider} store cannot delete objects`,
    );
  }
  return store.bucket.delete.bind(store.bucket);
}

/** Which configured stores hold the object, in store order. */
export async function locateStorageObject(
  objectKey: string,
  stores: readonly StorageStore[],
): Promise<ObjectLocation[]> {
  const found = await Promise.all(
    stores.map(async (store) => {
      const object = await inspector(store)(objectKey);
      return object ? { provider: store.provider, size: object.size } : null;
    }),
  );
  return found.filter((location): location is ObjectLocation => location !== null);
}

function sizeAgrees(observed: number | undefined, expected: number | undefined): boolean {
  return observed === undefined || expected === undefined || observed === expected;
}

// A copy whose size cannot be read is not a verified copy.
function measuredAs(observed: number | undefined, expected: number): boolean {
  return observed === expected;
}

// Measured, and equal to the record when the record says how large it is.
function measuredAgainstRecord(observed: number | undefined, expected: number | undefined): boolean {
  return observed !== undefined && sizeAgrees(observed, expected);
}

// Two moves of the same object in one isolate run one after the other. Across
// isolates the caller's lease is what serializes them.
const inFlight = new Map<string, Promise<unknown>>();

async function serialized<T>(objectKey: string, run: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(objectKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  inFlight.set(objectKey, current);
  try {
    return await current;
  } finally {
    if (inFlight.get(objectKey) === current) inFlight.delete(objectKey);
  }
}

/**
 * Move one object into the `to` store from wherever it currently is.
 *
 * `expectedSize` is what the File record says; a source object of another
 * size is refused rather than copied, since the record and the object then
 * disagree and the move would only spread the disagreement.
 */
export async function moveStorageObject({
  objectKey,
  to,
  stores,
  expectedSize,
  contentType,
  lease,
}: {
  objectKey: string;
  to: StorageProvider;
  stores: readonly StorageStore[];
  expectedSize?: number;
  contentType?: string;
  lease?: StorageMoveLease;
}): Promise<MoveOutcome> {
  const destination = stores.find((store) => store.provider === to);
  if (!destination) {
    throw new StorageMoveError("no-destination", `The ${to} store is not configured`);
  }
  return await serialized(objectKey, async () => {
    const held = (await lease?.acquire()) ?? "acquired";
    if (held === "gone") return { kind: "missing" };
    if (held === "busy") {
      throw new StorageMoveError(
        "contended",
        `${objectKey} is being moved elsewhere; nothing was changed`,
      );
    }
    try {
      return await moveLocatedObject({
        objectKey,
        to,
        stores,
        destination,
        expectedSize,
        contentType,
        stillExists: lease?.stillExists,
        confirm: lease?.confirm,
      });
    } finally {
      await lease?.release();
    }
  });
}

async function moveLocatedObject({
  objectKey,
  to,
  stores,
  destination,
  expectedSize,
  contentType,
  stillExists,
  confirm,
}: {
  objectKey: string;
  to: StorageProvider;
  stores: readonly StorageStore[];
  destination: StorageStore;
  expectedSize?: number;
  contentType?: string;
  stillExists?: () => Promise<boolean>;
  confirm?: () => Promise<boolean>;
}): Promise<MoveOutcome> {
  // Nothing is deleted by a move whose lease has lapsed: another move may
  // hold it by now and rely on the copy this one is about to remove.
  const deleteFrom = async (store: StorageStore): Promise<void> => {
    if (confirm && !(await confirm())) {
      throw new StorageMoveError(
        "contended",
        `${objectKey}: the move lease was lost before ${store.provider} could be cleaned up; nothing was deleted`,
      );
    }
    await remover(store)(objectKey);
  };
  const locations = await locateStorageObject(objectKey, stores);
  let atDestination = locations.find((location) => location.provider === to);
  const elsewhere = locations.filter((location) => location.provider !== to);

  if (
    atDestination &&
    elsewhere.length > 0 &&
    !measuredAgainstRecord(atDestination.size, expectedSize) &&
    elsewhere.some((location) => measuredAgainstRecord(location.size, expectedSize))
  ) {
    // A copy an earlier move wrote but never verified, next to a source that
    // does match the record. It would shadow the good copy on reads, so it
    // is replaced: removed here, then copied afresh below.
    await deleteFrom(destination);
    atDestination = undefined;
  }

  if (atDestination) {
    if (elsewhere.length === 0) {
      // The only copy there is. It counts as settled only when it is measured
      // and matches the record; otherwise there is nothing to repair it from.
      if (!measuredAgainstRecord(atDestination.size, expectedSize)) {
        throw new StorageMoveError(
          "size-mismatch",
          `${objectKey} in ${to} is ${atDestination.size ?? "of unknown size"}, not the recorded ${expectedSize}, and no other store holds a copy`,
        );
      }
      return { kind: "already-there", to, removedFrom: [] };
    }
    // A copy that a previous move left behind. Only remove it once the
    // destination copy is measured and, when the record says how large the
    // object is, agrees with it.
    if (atDestination.size === undefined || !sizeAgrees(atDestination.size, expectedSize)) {
      throw new StorageMoveError(
        "size-mismatch",
        `${objectKey} in ${to} is ${atDestination.size ?? "of unknown size"}, not the recorded ${expectedSize}`,
      );
    }
    const removedFrom: StorageProvider[] = [];
    for (const location of elsewhere) {
      const store = stores.find((candidate) => candidate.provider === location.provider)!;
      // Never remove the last copy: check the destination copy once more
      // right before deleting.
      const stillThere = await inspector(destination)(objectKey);
      if (!stillThere || !measuredAs(stillThere.size, atDestination.size)) {
        throw new StorageMoveError(
          "verification-failed",
          `${objectKey} in ${to} changed while its copy in ${location.provider} was about to be removed`,
        );
      }
      await deleteFrom(store);
      removedFrom.push(location.provider);
    }
    return { kind: "already-there", to, removedFrom };
  }

  const sourceLocation = elsewhere[0];
  if (!sourceLocation) return { kind: "missing" };
  const source = stores.find((store) => store.provider === sourceLocation.provider)!;
  if (!source.bucket.get) {
    throw new StorageMoveError(
      "unsupported",
      `The ${source.provider} store cannot read objects`,
    );
  }
  if (!sizeAgrees(sourceLocation.size, expectedSize)) {
    throw new StorageMoveError(
      "size-mismatch",
      `${objectKey} in ${source.provider} is ${sourceLocation.size} bytes, not the recorded ${expectedSize}`,
    );
  }

  const object = await source.bucket.get(objectKey);
  if (!object) return { kind: "missing" };
  const size = object.size ?? sourceLocation.size;
  // The object may have been replaced between HEAD and GET; what is copied
  // must be what the record describes.
  if (size === undefined || !sizeAgrees(size, expectedSize)) {
    await object.body?.cancel().catch(() => undefined);
    throw new StorageMoveError(
      "size-mismatch",
      `${objectKey} in ${source.provider} reads as ${size ?? "an unknown size"}, not the recorded ${expectedSize}`,
    );
  }
  const body: ArrayBuffer | ReadableStream =
    object.body ?? (object.arrayBuffer ? await object.arrayBuffer() : new ArrayBuffer(0));
  await withLeaseHeartbeat(
    destination.bucket.put(objectKey, body, {
      httpMetadata: contentType ? { contentType } : undefined,
      contentLength: size,
    }),
    confirm,
  );

  const copied = await inspector(destination)(objectKey);
  if (!copied || !measuredAs(copied.size, size)) {
    // Leave the source untouched and do not keep a copy of unknown shape. A
    // copy that could not be removed is reported too: it would shadow the
    // source on reads until the next run replaces it.
    const problem = `${objectKey} was copied to ${to} but reads back as ${copied?.size ?? "absent"} rather than ${size} bytes`;
    try {
      await deleteFrom(destination);
    } catch (error) {
      throw new StorageMoveError(
        "verification-failed",
        `${problem}; removing that copy failed as well (${describe(error)}), run the move again`,
      );
    }
    throw new StorageMoveError("verification-failed", problem);
  }

  if (stillExists) {
    let exists: boolean;
    try {
      exists = await stillExists();
    } catch (error) {
      // The caller could not tell, or could not queue a durable cleanup for
      // a deleted file. The fresh copy must not stay behind unnoticed: try to
      // remove it now, and if that fails too say exactly which key is loose.
      try {
        await deleteFrom(destination);
      } catch (removeError) {
        throw new StorageMoveError(
          "verification-failed",
          `${objectKey}: could not confirm the file still exists (${describe(error)}) and the copy in ${to} could not be removed (${describe(removeError)}); that copy is untracked`,
        );
      }
      throw error;
    }
    if (!exists) {
      // The record is gone; its deletion has already swept the stores, so the
      // copy written since is the only thing left and would otherwise leak.
      // stillExists has queued a durable cleanup for the key by now, so a
      // failure of this delete is retried later. The lease cannot be
      // confirmed against a deleted row, so this delete is not fenced.
      await remover(destination)(objectKey);
      return { kind: "missing" };
    }
  }

  let sourceRemoved = true;
  try {
    await deleteFrom(source);
  } catch (error) {
    if (error instanceof StorageMoveError) throw error;
    console.error(`Moved ${objectKey} to ${to} but could not delete it from ${source.provider}`, error);
    sourceRemoved = false;
  }
  return { kind: "moved", from: source.provider, to, size, sourceRemoved };
}

export type MovableFile = {
  id: string;
  name: string;
  objectKey: string;
  size: number;
  mimeType: string;
  /** Opaque position of this file in the scan, handed back as `nextCursor`. */
  cursor: string;
};

export type MoveBatchOutcome = {
  scanned: number;
  moved: number;
  alreadyThere: number;
  missing: number;
  failed: { id: string; name: string; error: string }[];
  /** Resume point for the next call; undefined once every file was seen. */
  nextCursor: string | undefined;
  done: boolean;
};

/**
 * Walk files page by page and bring each one into the `to` store, within a
 * bounded amount of work so one call fits inside a request. Each page is
 * located in parallel (only HEADs), while the copies run one at a time so a
 * batch never holds more than one object in flight.
 */
export async function moveStorageObjectsBatch({
  to,
  stores,
  nextPage,
  cursor,
  limits,
  onObjectChanged,
  lease,
  now = () => Date.now(),
}: {
  to: StorageProvider;
  stores: readonly StorageStore[];
  nextPage: (cursor: string | undefined) => Promise<MovableFile[]>;
  cursor: string | undefined;
  limits: { moves: number; scanned: number; milliseconds: number };
  /** Called for every outcome that deleted something: a move, or a leftover
   * copy removed from another store. Nothing is reported for a no-op. */
  onObjectChanged?: (
    file: MovableFile,
    outcome: Extract<MoveOutcome, { kind: "moved" | "already-there" }>,
  ) => Promise<void>;
  /** See moveStorageObject; one lease per file. */
  lease?: (file: MovableFile) => StorageMoveLease;
  now?: () => number;
}): Promise<MoveBatchOutcome> {
  if (!stores.some((store) => store.provider === to)) {
    throw new StorageMoveError("no-destination", `The ${to} store is not configured`);
  }
  const deadline = now() + limits.milliseconds;
  const outcome: MoveBatchOutcome = {
    scanned: 0,
    moved: 0,
    alreadyThere: 0,
    missing: 0,
    failed: [],
    nextCursor: cursor,
    done: false,
  };
  const exhausted = () =>
    outcome.moved >= limits.moves ||
    outcome.scanned >= limits.scanned ||
    now() >= deadline;

  for (;;) {
    if (outcome.scanned > 0 && exhausted()) return outcome;
    const page = await nextPage(outcome.nextCursor);
    if (page.length === 0) {
      outcome.done = true;
      outcome.nextCursor = undefined;
      return outcome;
    }
    // Only as many files as the scan limit still allows are looked up; the
    // rest of the page is reached again through the cursor.
    const remaining = Math.max(0, limits.scanned - outcome.scanned);
    const located = await Promise.all(
      page.slice(0, remaining).map(async (file) => {
        try {
          return { file, locations: await locateStorageObject(file.objectKey, stores) };
        } catch (error) {
          return { file, error };
        }
      }),
    );
    for (const entry of located) {
      // Locating a slow store can spend the whole budget before the first
      // entry; still settle one so every call advances the cursor.
      if (outcome.scanned > 0 && exhausted()) return outcome;
      outcome.scanned++;
      outcome.nextCursor = entry.file.cursor;
      if ("error" in entry) {
        outcome.failed.push({ id: entry.file.id, name: entry.file.name, error: describe(entry.error) });
        continue;
      }
      // Only a destination copy that is measured and matches the record
      // counts as settled; anything else goes through the mover, which
      // either repairs it or reports why it cannot.
      const settled =
        entry.locations.length === 1 &&
        entry.locations[0].provider === to &&
        measuredAgainstRecord(entry.locations[0].size, entry.file.size);
      if (settled) {
        outcome.alreadyThere++;
        continue;
      }
      if (entry.locations.length === 0) {
        outcome.missing++;
        continue;
      }
      try {
        const result = await moveStorageObject({
          objectKey: entry.file.objectKey,
          to,
          stores,
          expectedSize: entry.file.size,
          contentType: entry.file.mimeType,
          lease: lease?.(entry.file),
        });
        if (result.kind === "moved") {
          await onObjectChanged?.(entry.file, result);
          if (result.sourceRemoved) {
            outcome.moved++;
          } else {
            // The copy is in place, but the old store still holds one. Report
            // it as unfinished so the old store is not decommissioned on the
            // strength of a clean-looking batch; the next run removes it.
            outcome.failed.push({
              id: entry.file.id,
              name: entry.file.name,
              error: `copied to ${to} but the copy in ${result.from} could not be removed; run again`,
            });
          }
        } else if (result.kind === "already-there") {
          outcome.alreadyThere++;
          if (result.removedFrom.length > 0) await onObjectChanged?.(entry.file, result);
        } else {
          outcome.missing++;
        }
      } catch (error) {
        outcome.failed.push({ id: entry.file.id, name: entry.file.name, error: describe(error) });
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Keep the lease alive while a long copy is in flight. A failed renewal is
// not acted on here: the copy cannot be cancelled midway, and the confirm
// before the next delete refuses to proceed without the lease.
async function withLeaseHeartbeat<T>(
  work: Promise<T>,
  confirm: (() => Promise<boolean>) | undefined,
): Promise<T> {
  if (!confirm) return await work;
  let stopped = false;
  const heartbeat = (async () => {
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, LEASE_HEARTBEAT_MILLISECONDS));
      if (stopped) break;
      await confirm().catch(() => false);
    }
  })();
  try {
    return await work;
  } finally {
    stopped = true;
    void heartbeat;
  }
}
