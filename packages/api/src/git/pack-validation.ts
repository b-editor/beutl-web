import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { MAX_GIT_OBJECT_BYTES } from "./git-object-store";
import type { GitObjectInfo, GitObjectReader, GitObjectType } from "./object-reader";

// Bound validation work and isomorphic-git's per-command chunk allocations.
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
  unsigned(): number {
    let value: number, size = 0, scale = 1;
    do {
      value = this.byte(); size += (value & 127) * scale; scale *= 128;
      if (!Number.isSafeInteger(size)) throw new GitPackValidationError("Invalid Git delta size");
    } while (value & 128);
    return size;
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

/** Validate first, then optionally reconstruct into one bounded output buffer. */
function readDelta(data: Uint8Array, budget?: { remaining: number }, base?: Uint8Array) {
  const cursor = new Cursor(data), source = cursor.unsigned(), target = cursor.unsigned();
  checkSize(Math.max(source, target), MAX_GIT_OBJECT_BYTES);
  if (base && base.length !== source) throw new GitPackValidationError("Git delta base size mismatch");
  const object = base ? new Uint8Array(target) : undefined;
  let written = 0;
  while (cursor.position < data.length) {
    if (budget) consumeOperations(budget, 1);
    const command = cursor.byte();
    let length = 0, offset = 0;
    if (command & 128) {
      for (let i = 0; i < 4; i++) if (command & (1 << i)) offset += cursor.byte() * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (command & (16 << i)) length += cursor.byte() * 2 ** (8 * i);
      length ||= 0x10000;
      if (offset + length > source) throw new GitPackValidationError("Git delta exceeds its base");
    } else {
      if (!command || cursor.position + command > data.length) throw new GitPackValidationError("Invalid Git delta instruction");
      offset = cursor.position; length = command; cursor.position += length;
    }
    written += length;
    if (written > target) throw new GitPackValidationError("Git delta exceeds its declared output size");
    if (object) object.set((command & 128 ? base! : data).subarray(offset, offset + length), written - length);
  }
  if (written !== target) throw new GitPackValidationError("Git delta output size mismatch");
  return { source, target, object };
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
type Delta = { offset: number; data: Uint8Array; operations: number; baseOperations?: number; object?: GitObject };
export type ValidatedGitObject = GitObjectInfo & { data?: Uint8Array };

/** Bound expansion before indexing; keep non-blob contents for connectivity checks before storage. */
export async function validateGitPack(pack: Uint8Array, maximum: number, reader: GitObjectReader): Promise<Map<string, ValidatedGitObject>> {
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
          delta.object = { type: base.type, data: readDelta(delta.data, undefined, base.data).object!, operations };
          unresolved--;
        }
        delta.baseOperations = base.operations;
        publish(delta.object, delta.offset);
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
    cursor.position += inflated.engine.bytesWritten;
    expanded += size;
    if (type === 6 || type === 7) {
      const before = deltaBudget.remaining, delta = readDelta(inflated.buffer, deltaBudget);
      if (baseSize !== undefined && baseSize !== delta.source) throw new GitPackValidationError("Git delta base size mismatch");
      expanded += delta.target;
      offsets.set(start, delta.target);
      if (typeof base === "string") {
        if (bases.has(base) && bases.get(base) !== delta.source)
          throw new GitPackValidationError("Git delta base size mismatch");
        bases.set(base, delta.source);
      }
      const dependents = pending.get(base!) ?? [];
      dependents.push({ offset: start, data: inflated.buffer, operations: before - deltaBudget.remaining });
      pending.set(base!, dependents); unresolved++;
    } else {
      publish({ type: OBJECT_TYPES[type], data: inflated.buffer, operations: 0 }, start);
      offsets.set(start, size);
    }
    checkSize(expanded, maximum);
  }
  if (cursor.position !== cursor.bytes.length) throw new GitPackValidationError("Git pack object count mismatch");
  // A thin pack can reference older stored objects. Reject oversized legacy
  // bases before the library inflates them while resolving the incoming delta.
  let lookupsRemaining = MAX_GIT_PACK_BASE_LOOKUPS;
  const consumeLookup = () => {
    if (--lookupsRemaining < 0) throw new GitPackLimitError("Git pack exceeds its base lookup budget");
  };
  const stored = new Map<string, { object?: GitObject; instructions?: Uint8Array; base?: string; operations: number }>();
  resolve();
  for (const [base, source] of bases) {
    if (local.has(base)) continue;
    const chain: string[] = [];
    const info = await reader.info(base, consumeLookup, (size) => checkSize(size, MAX_GIT_OBJECT_BYTES), (oid, entry) => {
      const cached = stored.get(oid);
      // Cached validation saves parsing, but each stored chain visit can cause
      // reconstruction during indexing and must still consume its operation budget.
      if (cached) { consumeOperations(deltaBudget, cached.operations); return; }
      expanded += entry.size; checkSize(expanded, maximum);
      const header = entry.headerLength ?? 0;
      const data = inflateObject(entry.data, header + entry.size).buffer.subarray(header);
      if (entry.base) {
        const before = deltaBudget.remaining, delta = readDelta(data, deltaBudget);
        expanded += delta.target; checkSize(expanded, maximum);
        stored.set(oid, { instructions: data, base: entry.base, operations: before - deltaBudget.remaining });
      } else {
        stored.set(oid, { object: { type: OBJECT_TYPES[entry.type], data, operations: 0 }, operations: 0 });
      }
      chain.push(oid);
    });
    if (!info) continue; // A later stored base may unlock an incoming delta producing this OID.
    if (info.size !== source) throw new GitPackValidationError("Git delta base size mismatch");
    for (const oid of chain.reverse()) {
      const entry = stored.get(oid)!;
      if (!entry.instructions) continue;
      const base = stored.get(entry.base!)!.object!;
      entry.object = { type: base.type, data: readDelta(entry.instructions, undefined, base.data).object!,
        operations: base.operations + entry.operations };
      entry.instructions = undefined;
    }
    prepaidBases.add(base);
    publish(stored.get(base)!.object!);
    resolve();
  }
  if (unresolved) throw new GitPackValidationError("Git delta base is missing");
  for (const [oid, object] of local) if (typeof oid === "string")
    objects.set(oid, { type: object.type, size: object.data.byteLength, data: object.type === "blob" ? undefined : object.data });
  return objects;
}
