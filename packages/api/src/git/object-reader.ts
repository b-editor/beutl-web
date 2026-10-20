import { sha1, toHex } from "git-fs-s3";
import type { readGitRepository } from "./git-http";
import { MAX_GIT_OBJECT_BYTES } from "./git-object-store";
import { ByteReader, inflateStream, iteratorStream, sliceStream, streamBytes, streamPrefix } from "./streams";

type Repository = ReturnType<typeof readGitRepository>;
export type GitObjectType = "commit" | "tree" | "blob" | "tag";
export type PackedGitEntry = { type: number; size: number; base?: string; data: Uint8Array };
type Entry = PackedGitEntry & { headerLength?: number; loose?: true };
type Index = { bytes: Uint8Array; count: number; order: Uint32Array; offsets: Uint32Array };
export type GitObjectInfo = { type: GitObjectType; size: number };
const NAMES = 1032;
const TYPES: Record<number, GitObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function safeSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid Git object size");
  return size;
}
function byte(bytes: Uint8Array, cursor: { position: number }): number {
  if (cursor.position >= bytes.byteLength) throw new Error("Truncated Git object header");
  return bytes[cursor.position++];
}
function unsigned(bytes: Uint8Array, cursor: { position: number }): number {
  let value: number, size = 0, scale = 1;
  do { value = byte(bytes, cursor); size = safeSize(size + (value & 127) * scale); scale *= 128; } while (value & 128);
  return size;
}

/** Only compressed files are cached. Streams pin their delta chain before leaving the repository queue. */
export class GitObjectReader {
  private readonly files = new Map<string, Promise<Uint8Array | null>>();
  private readonly indexes = new Map<string, Promise<Index>>();
  private readonly packs = new Map<string, Promise<Uint8Array>>();
  private readonly entries = new Map<string, Promise<Entry | null>>();
  private readonly infos = new Map<string, GitObjectInfo>();
  private names?: Promise<string[]>;
  constructor(private readonly repository: Repository) {}

  private file(path: string): Promise<Uint8Array | null> {
    let pending = this.files.get(path);
    if (!pending) {
      pending = this.repository.fs.promises.readFile(path).then((data) => data as Uint8Array)
        .catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      this.files.set(path, pending);
    }
    return pending;
  }
  private index(path: string): Promise<Index> {
    let pending = this.indexes.get(path);
    if (!pending) {
      pending = (async () => {
        const bytes = await this.file(path);
        if (!bytes || bytes.byteLength < NAMES + 40) throw new Error("Truncated Git pack index");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(0) !== 0xff744f63 || view.getUint32(4) !== 2) throw new Error("Unsupported Git pack index");
        const count = view.getUint32(NAMES - 4);
        if (bytes.byteLength !== NAMES + count * 28 + 40) throw new Error("Invalid Git pack index length");
        if (await sha1(bytes.subarray(0, -20)) !== toHex(bytes.subarray(-20))) throw new Error("Invalid Git pack index checksum");
        const offsets = new Uint32Array(count), order = new Uint32Array(count);
        for (let i = 0; i < count; i++) {
          offsets[i] = view.getUint32(NAMES + count * 24 + i * 4); order[i] = i;
          if (offsets[i] & 0x80000000) throw new Error("Unsupported Git pack offset");
        }
        order.sort((a, b) => offsets[a] - offsets[b]);
        return { bytes, count, order, offsets };
      })();
      this.indexes.set(path, pending);
    }
    return pending;
  }
  private pack(path: string, index: Index): Promise<Uint8Array> {
    let pending = this.packs.get(path);
    if (!pending) {
      pending = (async () => {
        const bytes = await this.file(path);
        if (!bytes || bytes.byteLength < 32) throw new Error("Truncated Git pack");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(0) !== 0x5041434b || ![2, 3].includes(view.getUint32(4)) || view.getUint32(8) !== index.count)
          throw new Error("Git pack does not match its index");
        const expected = toHex(index.bytes.subarray(-40, -20));
        if (toHex(bytes.subarray(-20)) !== expected || await sha1(bytes.subarray(0, -20)) !== expected)
          throw new Error("Invalid Git pack checksum");
        for (let i = 0; i < index.count; i++) {
          const offset = index.offsets[index.order[i]];
          if (offset < 12 || offset >= bytes.byteLength - 20 || (i > 0 && offset === index.offsets[index.order[i - 1]]))
            throw new Error("Invalid Git pack offset");
        }
        return bytes;
      })();
      this.packs.set(path, pending);
    }
    return pending;
  }
  private oid(index: Index, ordinal: number): string {
    return toHex(index.bytes.subarray(NAMES + ordinal * 20, NAMES + (ordinal + 1) * 20));
  }
  private offsetPosition(index: Index, offset: number): number {
    let low = 0, high = index.count;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (index.offsets[index.order[middle]] < offset) low = middle + 1; else high = middle;
    }
    return low;
  }
  private packedEntry(index: Index, pack: Uint8Array, ordinal: number): Entry {
    const start = index.offsets[ordinal], position = this.offsetPosition(index, start);
    const end = position + 1 < index.count ? index.offsets[index.order[position + 1]] : pack.byteLength - 20;
    const bytes = pack.subarray(start, end), cursor = { position: 0 };
    let value = byte(bytes, cursor), size = value & 15, scale = 16;
    const type = (value >> 4) & 7;
    while (value & 128) { value = byte(bytes, cursor); size = safeSize(size + (value & 127) * scale); scale *= 128; }
    let base: string | undefined;
    if (type === 6) {
      value = byte(bytes, cursor); let distance = value & 127;
      while (value & 128) { value = byte(bytes, cursor); distance = safeSize((distance + 1) * 128 + (value & 127)); }
      const basePosition = this.offsetPosition(index, start - distance);
      if (basePosition >= index.count || index.offsets[index.order[basePosition]] !== start - distance)
        throw new Error("Git delta names no base");
      base = this.oid(index, index.order[basePosition]);
    } else if (type === 7) {
      const from = cursor.position;
      for (let i = 0; i < 20; i++) byte(bytes, cursor);
      base = toHex(bytes.subarray(from, cursor.position));
    } else if (!TYPES[type]) throw new Error("Unsupported Git object type");
    return { type, size, base, data: bytes.subarray(cursor.position) };
  }
  async packEntries(name: string): Promise<Map<string, PackedGitEntry>> {
    const path = `${this.repository.repo.gitdir}/objects/pack/${name}`;
    const index = await this.index(path.replace(/\.pack$/u, ".idx")), pack = await this.pack(path, index);
    return new Map(Array.from({ length: index.count }, (_, i) => [this.oid(index, i), this.packedEntry(index, pack, i)]));
  }
  private entry(oid: string): Promise<Entry | null> {
    if (!/^[0-9a-f]{40}$/u.test(oid)) throw new Error("Invalid Git object ID");
    let pending = this.entries.get(oid);
    if (!pending) { pending = this.findEntry(oid); this.entries.set(oid, pending); }
    return pending;
  }
  private async findEntry(oid: string): Promise<Entry | null> {
    const { repo, fs } = this.repository;
    const loose = await this.file(`${repo.gitdir}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`);
    if (loose) {
      const header = new TextDecoder().decode(await streamPrefix(inflateStream(loose), 64));
      const match = /^(commit|tree|blob|tag) (\d+)\0/u.exec(header);
      if (!match) throw new Error("Invalid loose Git object header");
      return { type: TYPE_CODES[match[1] as GitObjectType], size: safeSize(Number(match[2])),
        data: loose, headerLength: match[0].length, loose: true };
    }
    const directory = `${repo.gitdir}/objects/pack`;
    this.names ??= fs.promises.readdir(directory).then((names) => names.filter((name) => name.endsWith(".idx")))
      .catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    for (const name of await this.names) {
      const path = `${directory}/${name}`, index = await this.index(path);
      let low = 0, high = index.count;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (this.oid(index, middle) < oid) low = middle + 1; else high = middle;
      }
      if (low < index.count && this.oid(index, low) === oid)
        return this.packedEntry(index, await this.pack(path.replace(/\.idx$/u, ".pack"), index), low);
    }
    return null;
  }
  async info(oid: string): Promise<GitObjectInfo | null> {
    const cached = this.infos.get(oid);
    if (cached) return cached;
    const entry = await this.entry(oid);
    if (!entry) return null;
    let type = entry.type, base = entry.base;
    const seen = new Set([oid]);
    while (base) {
      if (seen.has(base)) throw new Error("Git delta bases form a cycle");
      seen.add(base);
      const source = await this.entry(base);
      if (!source) throw new Error(`Git delta base ${base} is missing`);
      type = source.type; base = source.base;
    }
    let size = entry.size;
    if (entry.base) {
      const header = await streamPrefix(inflateStream(entry.data), 16), cursor = { position: 0 };
      unsigned(header, cursor); size = unsigned(header, cursor);
    }
    const info = { type: TYPES[type], size };
    if (!info.type) throw new Error("Unsupported Git object type");
    this.infos.set(oid, info); return info;
  }
  async size(oid: string): Promise<number | null> { return (await this.info(oid))?.size ?? null; }

  async read(oid: string, maximum = MAX_GIT_OBJECT_BYTES): Promise<Uint8Array<ArrayBuffer>> {
    const info = await this.info(oid);
    if (!info) throw new Error(`Git object ${oid} is missing`);
    if (info.size > maximum) throw new RangeError("Git metadata exceeds the read limit");
    return streamBytes(await this.stream(oid), info.size);
  }
  async stream(oid: string, range?: { offset: number; length: number }): Promise<ReadableStream<Uint8Array>> {
    const info = await this.info(oid), entry = await this.entry(oid);
    if (!info || !entry) throw new Error(`Git object ${oid} is missing`);
    const start = range?.offset ?? 0, length = range?.length ?? info.size;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > info.size)
      throw new RangeError("Invalid Git object byte range");
    if (!entry.base) return sliceStream(inflateStream(entry.data), (entry.headerLength ?? 0) + start, length,
      (entry.headerLength ?? 0) + info.size);
    return iteratorStream(this.delta(entry, info.size, start, length));
  }
  private async *delta(entry: Entry, size: number, start: number, length: number): AsyncGenerator<Uint8Array, void> {
    const instructions = new ByteReader(inflateStream(entry.data));
    let baseReader: ByteReader | undefined, basePosition = 0, position = 0;
    const end = start + length;
    try {
      const baseInfo = await this.info(entry.base!);
      if (!baseInfo || await instructions.unsigned() !== baseInfo.size || await instructions.unsigned() !== size)
        throw new Error("Git delta size differs from its base or result");
      while (position < end) {
        const opcode = await instructions.byte();
        if (opcode & 128) {
          let offset = 0, count = 0;
          for (let i = 0; i < 4; i++) if (opcode & (1 << i)) offset += (await instructions.byte()) * 2 ** (i * 8);
          for (let i = 0; i < 3; i++) if (opcode & (1 << (i + 4))) count += (await instructions.byte()) * 2 ** (i * 8);
          count ||= 65536;
          if (offset + count > baseInfo.size || position + count > size) throw new Error("Git delta copy is out of bounds");
          const from = Math.max(start, position), to = Math.min(end, position + count);
          if (to > from) {
            const needed = offset + from - position;
            if (!baseReader || needed < basePosition) {
              await baseReader?.cancel(); baseReader = new ByteReader(await this.stream(entry.base!)); basePosition = 0;
            }
            await baseReader.skip(needed - basePosition); basePosition = needed;
            let remaining = to - from;
            while (remaining > 0) {
              const bytes = await baseReader.take(remaining);
              if (!bytes) throw new Error("Truncated Git delta base");
              basePosition += bytes.byteLength; remaining -= bytes.byteLength; yield bytes;
            }
          }
          position += count;
        } else {
          if (opcode === 0 || position + opcode > size) throw new Error("Invalid Git delta insert");
          let remaining = opcode;
          while (remaining > 0) {
            const bytes = await instructions.take(remaining);
            if (!bytes) throw new Error("Truncated Git delta insert");
            const from = Math.max(start, position), to = Math.min(end, position + bytes.byteLength);
            if (to > from) yield bytes.subarray(from - position, to - position);
            remaining -= bytes.byteLength; position += bytes.byteLength;
          }
        }
      }
      if (end === size && await instructions.take(1)) throw new Error("Git delta has excess instructions");
    } finally { await instructions.cancel(); await baseReader?.cancel(); }
  }
  /** The raw compressed entry for pack rewrites; loose objects are recompressed as a stream. */
  async packed(oid: string): Promise<PackedGitEntry> {
    const entry = await this.entry(oid);
    if (!entry) throw new Error(`Git object ${oid} is missing`);
    if (!entry.loose) return entry;
    const input = (await this.stream(oid)).pipeThrough(new TransformStream<Uint8Array, BufferSource>({
      transform(chunk, controller) { controller.enqueue(Uint8Array.from(chunk)); },
    })).pipeThrough(new CompressionStream("deflate"));
    const reader = input.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength;
        if (length > MAX_GIT_OBJECT_BYTES) throw new RangeError("Compressed Git object exceeds the serving limit");
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const data = new Uint8Array(length); let position = 0;
    for (const chunk of chunks) { data.set(chunk, position); position += chunk.byteLength; }
    return { type: entry.type, size: entry.size, data };
  }
}
