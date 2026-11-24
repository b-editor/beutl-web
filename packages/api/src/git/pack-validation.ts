import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { MAX_GIT_OBJECT_BYTES } from "./git-object-store";
import type { GitObjectInfo, GitObjectReader, GitObjectType } from "./object-reader";
import { GitDeltaError, readDelta, readDeltaHeader } from "./pack-delta";
import { buildGitPackIndex, crc32, type GitPackIndexRecord } from "./pack-writer";

// Bound validation and subsequent delta replay work.
// Share the budget across the pack rather than resetting it for each delta.
const MAX_GIT_PACK_DELTA_OPERATIONS = 262_144;
// Count entry visits and index probes, including cached indexes and base chains,
// so many distinct thin bases cannot multiply work by the repository's pack count.
const MAX_GIT_PACK_BASE_LOOKUPS = 65_536;
const OBJECT_TYPES: Record<number, GitObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

export class GitPackValidationError extends Error {}
export class GitPackLimitError extends GitPackValidationError {}

class Cursor {
  position = 0;
  constructor(readonly bytes: Uint8Array) {}
  byte(): number {
    if (this.position >= this.bytes.length) throw new GitPackValidationError("Truncated Git pack");
    return this.bytes[this.position++];
  }
}

function checkSize(size: number, maximum: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new GitPackValidationError("Invalid Git object size");
  if (size > maximum) throw new GitPackLimitError("Expanded Git pack exceeds the memory limit; use Git LFS");
}

function consumeOperations(budget: { remaining: number }, count: number): void {
  budget.remaining -= count;
  if (budget.remaining < 0) throw new GitPackLimitError("Git pack exceeds its delta operation budget");
}

function validateDelta(data: Uint8Array, budget?: { remaining: number }, base?: Uint8Array) {
  try {
    const header = readDeltaHeader(data);
    checkSize(Math.max(header.source, header.target), MAX_GIT_OBJECT_BYTES);
    return { ...header, object: readDelta(data, header, base, budget ? () => consumeOperations(budget, 1) : undefined) };
  } catch (error) {
    if (error instanceof GitDeltaError) throw new GitPackValidationError(error.message);
    throw error;
  }
}

function inflateObject(data: Uint8Array, size: number) {
  let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    // info supplies the consumed compressed length, including when more
    // entries follow. The output cap also catches a dishonest pack header.
    inflated = inflateSync(data, { info: true, maxOutputLength: Math.max(1, size) }) as unknown as typeof inflated;
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
      throw new GitPackLimitError("Git object exceeds its declared expansion limit");
    if (["Z_DATA_ERROR", "Z_BUF_ERROR", "Z_NEED_DICT"].includes((error as { code?: string }).code ?? ""))
      throw new GitPackValidationError("Invalid compressed Git object");
    throw error;
  }
  if (inflated.buffer.length !== size) throw new GitPackValidationError("Git object size mismatch");
  return inflated;
}

type GitObject = { type: GitObjectType; data: Uint8Array; operations: number; oid?: string };
type Delta = { offset: number; data: Uint8Array; operations: number; baseOperations?: number; object?: GitObject; record?: GitPackIndexRecord };
export type ValidatedGitObject = GitObjectInfo & { data?: Uint8Array };

export function validateGitPack(pack: Uint8Array, maximum: number, reader: GitObjectReader): Promise<Map<string, ValidatedGitObject>> {
  return validatePack(pack, maximum, reader);
}

export async function validateAndIndexGitPack(pack: Uint8Array, maximum: number, reader: GitObjectReader) {
  const records: GitPackIndexRecord[] = [];
  const objects = await validatePack(pack, maximum, reader, records);
  const index = pack.length ? buildGitPackIndex(records, pack.subarray(-20)) : new Uint8Array();
  return { objects, index };
}

/** Bound expansion and keep non-blob contents for connectivity checks before storage. */
async function validatePack(pack: Uint8Array, maximum: number, reader: GitObjectReader, records?: GitPackIndexRecord[]) {
  const objects = new Map<string, ValidatedGitObject>();
  if (!pack.length) return objects;
  if (createHash("sha1").update(pack.subarray(0, -20)).digest("hex") !== Buffer.from(pack.subarray(-20)).toString("hex"))
    throw new GitPackValidationError("Invalid Git pack checksum");
  const cursor = new Cursor(pack.subarray(0, -20));
  cursor.position = 12;
  const count = new DataView(pack.buffer, pack.byteOffset).getUint32(8);
  const offsets = new Map<number, number>(), bases = new Map<string, number>();
  const local = new Map<string | number, GitObject>(), ready: (string | number)[] = [];
  const pending = new Map<string | number, Delta[]>(), queued = new Set<string | number>();
  const prepaidBases = new Set<string | number>();
  let next = 0, unresolved = 0;
  const publish = (object: GitObject, offset?: number) => {
    const oid = object.oid ??= createHash("sha1").update(`${object.type} ${object.data.length}\0`).update(object.data).digest("hex");
    for (const key of offset === undefined ? [oid] : [oid, offset]) {
      const previous = local.get(key);
      // An OID may have several encodings. Propagate the greatest replay cost,
      // even when a cheaper encoding has already resolved its dependents.
      if (previous && previous.operations >= object.operations) continue;
      local.set(key, object);
      if (!queued.has(key)) { ready.push(key); queued.add(key); }
    }
    return oid;
  };
  const resolve = () => {
    while (next < ready.length) {
      const key = ready[next++], base = local.get(key)!; queued.delete(key);
      for (const delta of pending.get(key) ?? []) {
        if (delta.object && delta.baseOperations === base.operations) continue;
        // Stored-base inspection already paid for its first replay. Every
        // other dependent pays the full cumulative cost of its ancestors.
        if (delta.object || !prepaidBases.delete(key))
          consumeOperations(deltaBudget, base.operations - (delta.baseOperations ?? 0));
        const operations = base.operations + delta.operations;
        if (delta.object) delta.object = { ...delta.object, operations };
        else {
          delta.object = { type: base.type, data: validateDelta(delta.data, undefined, base.data).object!, operations };
          unresolved--;
        }
        delta.baseOperations = base.operations;
        const oid = publish(delta.object, delta.offset);
        if (delta.record) delta.record.oid = oid;
      }
    }
  };
  const deltaBudget = { remaining: MAX_GIT_PACK_DELTA_OPERATIONS };
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    const start = cursor.position;
    let value = cursor.byte(), size = value & 15, scale = 16;
    const type = (value >> 4) & 7;
    while (value & 128) {
      value = cursor.byte(); size += (value & 127) * scale; scale *= 128;
      checkSize(size, MAX_GIT_OBJECT_BYTES);
    }
    checkSize(expanded + size, maximum);
    let base: string | number | undefined, baseSize: number | undefined;
    if (type === 6) {
      value = cursor.byte(); let distance = value & 127;
      while (value & 128) {
        value = cursor.byte(); distance = (distance + 1) * 128 + (value & 127);
        if (!Number.isSafeInteger(distance)) throw new GitPackValidationError("Invalid Git delta offset");
      }
      base = start - distance; baseSize = offsets.get(base);
      if (baseSize === undefined) throw new GitPackValidationError("Git delta names no preceding base");
    } else if (type === 7) {
      base = "";
      for (let i = 0; i < 20; i++) base += cursor.byte().toString(16).padStart(2, "0");
    } else if (type < 1 || type > 4) throw new GitPackValidationError("Unsupported Git object type");

    const inflated = inflateObject(cursor.bytes.subarray(cursor.position), size);
    const end = cursor.position += inflated.engine.bytesWritten;
    let record: GitPackIndexRecord | undefined;
    if (records) {
      // Each physical entry gets a row, even if its OID is shared by another entry.
      record = { offset: start, crc: crc32([pack.subarray(start, end)]), oid: "" };
      records.push(record);
    }
    expanded += size;
    if (type === 6 || type === 7) {
      const before = deltaBudget.remaining, delta = validateDelta(inflated.buffer, deltaBudget);
      if (baseSize !== undefined && baseSize !== delta.source) throw new GitPackValidationError("Git delta base size mismatch");
      expanded += delta.target;
      offsets.set(start, delta.target);
      if (typeof base === "string") {
        if (bases.has(base) && bases.get(base) !== delta.source)
          throw new GitPackValidationError("Git delta base size mismatch");
        bases.set(base, delta.source);
      }
      const dependents = pending.get(base!) ?? [];
      dependents.push({ offset: start, data: inflated.buffer, operations: before - deltaBudget.remaining, record });
      pending.set(base!, dependents); unresolved++;
    } else {
      const oid = publish({ type: OBJECT_TYPES[type], data: inflated.buffer, operations: 0 }, start);
      if (record) record.oid = oid;
      offsets.set(start, size);
    }
    checkSize(expanded, maximum);
  }
  if (cursor.position !== cursor.bytes.length) throw new GitPackValidationError("Git pack object count mismatch");
  // Check the sizes of stored bases before applying incoming thin deltas.
  let lookupsRemaining = MAX_GIT_PACK_BASE_LOOKUPS;
  const consumeLookup = () => {
    if (--lookupsRemaining < 0) throw new GitPackLimitError("Git pack exceeds its base lookup budget");
  };
  const stored = new Map<string, { object?: GitObject; instructions?: Uint8Array; operations: number }>();
  resolve();
  for (const [base, source] of bases) {
    if (local.has(base)) continue;
    const chain: string[] = [];
    const info = await reader.info(base, consumeLookup, (size) => checkSize(size, MAX_GIT_OBJECT_BYTES), (oid, entry) => {
      const key = entry.packId ?? oid;
      chain.push(key);
      const cached = stored.get(key);
      // Keep the replay budget for every stored chain visit, including cached ones.
      if (cached) { consumeOperations(deltaBudget, cached.operations); return; }
      expanded += entry.size; checkSize(expanded, maximum);
      const header = entry.headerLength ?? 0;
      const data = inflateObject(entry.data, header + entry.size).buffer.subarray(header);
      if (entry.base) {
        const before = deltaBudget.remaining, delta = validateDelta(data, deltaBudget);
        expanded += delta.target; checkSize(expanded, maximum);
        stored.set(key, { instructions: data, operations: before - deltaBudget.remaining });
        return data;
      }
      stored.set(key, { object: { type: OBJECT_TYPES[entry.type], data, operations: 0 }, operations: 0 });
    });
    if (!info) continue; // A later stored base may unlock an incoming delta producing this OID.
    if (info.size !== source) throw new GitPackValidationError("Git delta base size mismatch");
    for (let i = chain.length - 1; i >= 0; i--) {
      const entry = stored.get(chain[i])!;
      if (!entry.instructions) continue;
      const baseObject = stored.get(chain[i + 1])!.object!;
      entry.object = { type: baseObject.type, data: validateDelta(entry.instructions, undefined, baseObject.data).object!,
        operations: baseObject.operations + entry.operations };
      entry.instructions = undefined;
    }
    prepaidBases.add(base);
    publish(stored.get(chain[0])!.object!);
    resolve();
  }
  if (unresolved) throw new GitPackValidationError("Git delta base is missing");
  for (const [oid, object] of local) if (typeof oid === "string")
    objects.set(oid, { type: object.type, size: object.data.byteLength, data: object.type === "blob" ? undefined : object.data });
  return objects;
}
