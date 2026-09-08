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
  const locations = await locateStorageObject(objectKey, stores);
  const atDestination = locations.find((location) => location.provider === to);
  const elsewhere = locations.filter((location) => location.provider !== to);

  if (atDestination) {
    if (elsewhere.length === 0) return { kind: "already-there", to, removedFrom: [] };
    // A copy that a previous move left behind. Only remove it once the
    // destination copy is known to be the right size.
    if (!sizeAgrees(atDestination.size, expectedSize)) {
      throw new StorageMoveError(
        "size-mismatch",
        `${objectKey} in ${to} is ${atDestination.size} bytes, not the recorded ${expectedSize}`,
      );
    }
    const removedFrom: StorageProvider[] = [];
    for (const location of elsewhere) {
      const store = stores.find((candidate) => candidate.provider === location.provider)!;
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
  const size = object.size ?? sourceLocation.size ?? expectedSize;
  if (size === undefined) {
    throw new StorageMoveError(
      "size-mismatch",
      `${objectKey} in ${source.provider} has no measurable size`,
    );
  }
  const body: ArrayBuffer | ReadableStream =
    object.body ?? (object.arrayBuffer ? await object.arrayBuffer() : new ArrayBuffer(0));
  await destination.bucket.put(objectKey, body, {
    httpMetadata: contentType ? { contentType } : undefined,
    contentLength: size,
  });

  const copied = await inspector(destination)(objectKey);
  if (!copied || !sizeAgrees(copied.size, size)) {
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
  onMoved,
  now = () => Date.now(),
}: {
  to: StorageProvider;
  stores: readonly StorageStore[];
  nextPage: (cursor: string | undefined) => Promise<MovableFile[]>;
  cursor: string | undefined;
  limits: { moves: number; scanned: number; milliseconds: number };
  onMoved?: (file: MovableFile, outcome: Extract<MoveOutcome, { kind: "moved" }>) => Promise<void>;
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
          await onMoved?.(entry.file, result);
        } else if (result.kind === "already-there") {
          outcome.alreadyThere++;
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
