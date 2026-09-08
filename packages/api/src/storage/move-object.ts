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

export class StorageMoveError extends Error {
  readonly reason:
    | "no-destination"
    | "size-mismatch"
    | "verification-failed"
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

// Two moves of the same object in one isolate run one after the other, so an
// opposing pair cannot each delete the copy the other relies on. Separate
// isolates still race across the short window between the final check and
// the delete; the check below narrows it.
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
}: {
  objectKey: string;
  to: StorageProvider;
  stores: readonly StorageStore[];
  expectedSize?: number;
  contentType?: string;
}): Promise<MoveOutcome> {
  const destination = stores.find((store) => store.provider === to);
  if (!destination) {
    throw new StorageMoveError("no-destination", `The ${to} store is not configured`);
  }
  return await serialized(objectKey, () =>
    moveLocatedObject({ objectKey, to, stores, destination, expectedSize, contentType }),
  );
}

async function moveLocatedObject({
  objectKey,
  to,
  stores,
  destination,
  expectedSize,
  contentType,
}: {
  objectKey: string;
  to: StorageProvider;
  stores: readonly StorageStore[];
  destination: StorageStore;
  expectedSize?: number;
  contentType?: string;
}): Promise<MoveOutcome> {
  const locations = await locateStorageObject(objectKey, stores);
  const atDestination = locations.find((location) => location.provider === to);
  const elsewhere = locations.filter((location) => location.provider !== to);

  if (atDestination) {
    if (elsewhere.length === 0) return { kind: "already-there", to, removedFrom: [] };
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
      // An opposing move may have taken the destination copy since it was
      // located; never remove the last copy.
      const stillThere = await inspector(destination)(objectKey);
      if (!stillThere || !measuredAs(stillThere.size, atDestination.size)) {
        throw new StorageMoveError(
          "verification-failed",
          `${objectKey} in ${to} changed while its copy in ${location.provider} was about to be removed`,
        );
      }
      await remover(store)(objectKey);
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
  await destination.bucket.put(objectKey, body, {
    httpMetadata: contentType ? { contentType } : undefined,
    contentLength: size,
  });

  const copied = await inspector(destination)(objectKey);
  if (!copied || !measuredAs(copied.size, size)) {
    // Leave the source untouched and do not keep a copy of unknown shape.
    await remover(destination)(objectKey).catch(() => undefined);
    throw new StorageMoveError(
      "verification-failed",
      `${objectKey} was copied to ${to} but reads back as ${copied?.size ?? "absent"} rather than ${size} bytes`,
    );
  }

  let sourceRemoved = true;
  try {
    await remover(source)(objectKey);
  } catch (error) {
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
    if (exhausted()) return outcome;
    const page = await nextPage(outcome.nextCursor);
    if (page.length === 0) {
      outcome.done = true;
      outcome.nextCursor = undefined;
      return outcome;
    }
    const located = await Promise.all(
      page.map(async (file) => {
        try {
          return { file, locations: await locateStorageObject(file.objectKey, stores) };
        } catch (error) {
          return { file, error };
        }
      }),
    );
    for (const entry of located) {
      if (exhausted()) return outcome;
      outcome.scanned++;
      outcome.nextCursor = entry.file.cursor;
      if ("error" in entry) {
        outcome.failed.push({ id: entry.file.id, name: entry.file.name, error: describe(entry.error) });
        continue;
      }
      const settled =
        entry.locations.length === 1 && entry.locations[0].provider === to;
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
        });
        if (result.kind === "moved") {
          outcome.moved++;
          await onObjectChanged?.(entry.file, result);
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
