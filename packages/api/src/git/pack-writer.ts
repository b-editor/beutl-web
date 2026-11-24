import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { PackedGitEntry } from "./object-reader";
import { chunksStream, iteratorStream } from "./streams";

export function packEntryHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let value = (type << 4) | (size & 15);
  for (let rest = Math.floor(size / 16); rest > 0; rest = Math.floor(rest / 128)) {
    bytes.push(value | 128); value = rest & 127;
  }
  bytes.push(value); return Uint8Array.from(bytes);
}
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let i = 0; i < 8; i++) byte = byte & 1 ? 0xedb88320 ^ (byte >>> 1) : byte >>> 1;
  return byte >>> 0;
});
export function crc32(chunks: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const chunk of chunks) for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export const gitIndexBytes = (count: number) => 1072 + count * 28;

export type GitPackIndexRecord = { oid: string; crc: number; offset: number };

export function buildGitPackIndex(records: GitPackIndexRecord[], packChecksum: Uint8Array): Uint8Array<ArrayBuffer> {
  records.sort((a, b) => a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : a.offset - b.offset);
  const index = new Uint8Array(gitIndexBytes(records.length)), table = new DataView(index.buffer);
  table.setUint32(0, 0xff744f63); table.setUint32(4, 2);
  const names = 1032, crcs = names + records.length * 20, offsets = crcs + records.length * 4;
  const fanout = new Uint32Array(256);
  for (let i = 0; i < records.length; i++) {
    const record = records[i], oid = Buffer.from(record.oid, "hex");
    fanout[oid[0]]++;
    index.set(oid, names + i * 20);
    table.setUint32(crcs + i * 4, record.crc);
    table.setUint32(offsets + i * 4, record.offset);
  }
  for (let i = 0, total = 0; i < 256; i++) { total += fanout[i]; table.setUint32(8 + i * 4, total); }
  index.set(packChecksum, index.byteLength - 40);
  index.set(createHash("sha1").update(index.subarray(0, -20)).digest(), index.byteLength - 20);
  return index;
}

/** Reuse verified compressed entries, converting relative deltas to named bases without inflating them. */
export function createGitPack(entries: { oid: string; entry: PackedGitEntry }[], { index = false } = {}) {
  const header = new Uint8Array(12), view = new DataView(header.buffer);
  view.setUint32(0, 0x5041434b); view.setUint32(4, 2); view.setUint32(8, entries.length);
  const chunks: Uint8Array[] = [header], records: GitPackIndexRecord[] = [];
  const hash = createHash("sha1"); hash.update(header);
  let position = 12;
  for (const { oid, entry } of entries) {
    const data = [packEntryHeader(entry.base ? 7 : entry.type, entry.size), ...(entry.base ? [Buffer.from(entry.base, "hex")] : []), entry.data];
    if (index) records.push({ oid, offset: position, crc: crc32(data) });
    for (const part of data) { chunks.push(part); hash.update(part); position += part.byteLength; }
  }
  const checksum = hash.digest(); chunks.push(checksum);
  const indexBytes = index ? buildGitPackIndex(records, checksum) : undefined;
  return { byteLength: position + 20, checksum: checksum.toString("hex"), index: indexBytes, stream: () => chunksStream(chunks) };
}

/** Git's response framing stays streamed as well, including side-band packet boundaries. */
export function gitPackResponse(pack: ReturnType<typeof createGitPack>, acknowledgment: Uint8Array, sideBand: number | null): Response {
  const body = iteratorStream((async function* () {
    yield acknowledgment;
    const reader = pack.stream().getReader();
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        if (sideBand === null) { yield next.value; continue; }
        for (let offset = 0; offset < next.value.byteLength; offset += sideBand) {
          const data = next.value.subarray(offset, offset + sideBand), packet = new Uint8Array(data.byteLength + 5);
          packet.set(new TextEncoder().encode(packet.byteLength.toString(16).padStart(4, "0")));
          packet[4] = 1; packet.set(data, 5); yield packet;
        }
      }
      if (sideBand !== null) yield new TextEncoder().encode("0000");
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  })());
  return new Response(body, { headers: { "Content-Type": "application/x-git-upload-pack-result", "Cache-Control": "no-cache" } });
}
