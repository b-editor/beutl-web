import { inflateSync } from "node:zlib";
import { sha1, toHex } from "git-fs-s3";
import { MAX_GIT_OBJECT_BYTES } from "./git-object-store";
import type { GitObjectReader } from "./object-reader";

// Bound validation work and isomorphic-git's per-command chunk allocations.
// Share the budget across the pack rather than resetting it for each delta.
const MAX_GIT_PACK_DELTA_OPERATIONS = 262_144;
// Count entry visits and index probes, including cached indexes and base chains,
// so many distinct thin bases cannot multiply work by the repository's pack count.
const MAX_GIT_PACK_BASE_LOOKUPS = 65_536;

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

/** Check delta output without allocating it, including forged output lengths. */
function deltaSize(data: Uint8Array, budget: { remaining: number }): { source: number; target: number } {
  const cursor = new Cursor(data), source = cursor.unsigned(), target = cursor.unsigned();
  checkSize(Math.max(source, target), MAX_GIT_OBJECT_BYTES);
  let written = 0;
  while (cursor.position < data.length) {
    if (--budget.remaining < 0) throw new GitPackLimitError("Git pack exceeds its delta operation budget");
    const command = cursor.byte();
    let length = 0;
    if (command & 128) {
      let offset = 0;
      for (let i = 0; i < 4; i++) if (command & (1 << i)) offset += cursor.byte() * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (command & (16 << i)) length += cursor.byte() * 2 ** (8 * i);
      length ||= 0x10000;
      if (offset + length > source) throw new GitPackValidationError("Git delta exceeds its base");
    } else {
      if (!command || cursor.position + command > data.length) throw new GitPackValidationError("Invalid Git delta instruction");
      length = command; cursor.position += length;
    }
    written += length;
    if (written > target) throw new GitPackValidationError("Git delta exceeds its declared output size");
  }
  if (written !== target) throw new GitPackValidationError("Git delta output size mismatch");
  return { source, target };
}

/** Bound expansion before isomorphic-git indexes or caches full object buffers. */
export async function validateGitPack(pack: Uint8Array, maximum: number, reader: GitObjectReader): Promise<void> {
  if (!pack.length) return;
  if (await sha1(pack.subarray(0, -20)) !== toHex(pack.subarray(-20)))
    throw new GitPackValidationError("Invalid Git pack checksum");
  const cursor = new Cursor(pack.subarray(0, -20));
  cursor.position = 12;
  const count = new DataView(pack.buffer, pack.byteOffset).getUint32(8);
  const offsets = new Set<number>(), bases = new Map<string, number>();
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
    let base: string | undefined;
    if (type === 6) {
      value = cursor.byte(); let distance = value & 127;
      while (value & 128) {
        value = cursor.byte(); distance = (distance + 1) * 128 + (value & 127);
        if (!Number.isSafeInteger(distance)) throw new GitPackValidationError("Invalid Git delta offset");
      }
      if (!offsets.has(start - distance)) throw new GitPackValidationError("Git delta names no preceding base");
    } else if (type === 7) {
      base = "";
      for (let i = 0; i < 20; i++) base += cursor.byte().toString(16).padStart(2, "0");
    } else if (type < 1 || type > 4) throw new GitPackValidationError("Unsupported Git object type");

    let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      // info supplies the consumed compressed length, including when more
      // entries follow. The output cap also catches a dishonest pack header.
      inflated = inflateSync(cursor.bytes.subarray(cursor.position), {
        info: true, maxOutputLength: Math.max(1, size),
      }) as unknown as typeof inflated;
    } catch (error) {
      if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
        throw new GitPackLimitError("Git object exceeds its declared expansion limit");
      if (["Z_DATA_ERROR", "Z_BUF_ERROR", "Z_NEED_DICT"].includes((error as { code?: string }).code ?? ""))
        throw new GitPackValidationError("Invalid compressed Git object");
      throw error;
    }
    if (inflated.buffer.length !== size) throw new GitPackValidationError("Git object size mismatch");
    cursor.position += inflated.engine.bytesWritten;
    expanded += size;
    if (type === 6 || type === 7) {
      const delta = deltaSize(inflated.buffer, deltaBudget);
      expanded += delta.target;
      if (base) {
        if (bases.has(base) && bases.get(base) !== delta.source)
          throw new GitPackValidationError("Git delta base size mismatch");
        bases.set(base, delta.source);
      }
    }
    checkSize(expanded, maximum);
    offsets.add(start);
  }
  if (cursor.position !== cursor.bytes.length) throw new GitPackValidationError("Git pack object count mismatch");
  // A thin pack can reference older stored objects. Reject oversized legacy
  // bases before the library inflates them while resolving the incoming delta.
  let lookupsRemaining = MAX_GIT_PACK_BASE_LOOKUPS;
  const consumeLookup = () => {
    if (--lookupsRemaining < 0) throw new GitPackLimitError("Git pack exceeds its base lookup budget");
  };
  for (const [base, source] of bases) {
    const size = await reader.size(base, consumeLookup);
    if (size !== null) {
      checkSize(size, MAX_GIT_OBJECT_BYTES);
      if (size !== source) throw new GitPackValidationError("Git delta base size mismatch");
      expanded += size; checkSize(expanded, maximum);
    }
  }
}
