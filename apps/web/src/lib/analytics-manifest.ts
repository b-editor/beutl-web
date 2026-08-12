import "server-only";

import {
  analyticsManifestV1MaxBytes,
  analyticsManifestV1Path,
  parseAnalyticsManifestV1Json,
} from "@beutl/core";
import { Inflate } from "fflate";

export const marketplacePackageMaxBytes = 1024 * 1024 * 1024;

const maximumTargetCompressedBytes = 1024 * 1024;
const maximumEndRecordBytes = 22 + 0xffff;
const inflateInputChunkBytes = 32;
const targetNameBytes = new TextEncoder().encode(analyticsManifestV1Path);

type CentralDirectory = Readonly<{
  offset: number;
  size: number;
  entries: number;
}>;

type CentralEntry = Readonly<{
  name: string | null;
  nameBytes: Uint8Array;
  flags: number;
  compression: number;
  crc32: number;
  compressedSize: number;
  originalSize: number;
  localHeaderOffset: number;
  zip64Sizes: boolean;
}>;

type TargetEntry = CentralEntry & Readonly<{
  name: string;
}>;

export class PackageAnalyticsManifestError extends Error {
  constructor() {
    super("The package analytics manifest is invalid.");
    this.name = "PackageAnalyticsManifestError";
  }
}

function invalidManifest(): never {
  throw new PackageAnalyticsManifestError();
}

function isNuGetPackage(file: Pick<File, "name">): boolean {
  return file.name.toLowerCase().endsWith(".nupkg");
}

function requireSafeInteger(value: bigint): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return invalidManifest();
  }
  return Number(value);
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint16(offset, true);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(offset, true);
}

function readUint64(bytes: Uint8Array, offset: number): number {
  return requireSafeInteger(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      .getBigUint64(offset, true),
  );
}

async function readRange(
  file: Blob,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > file.size
  ) {
    return invalidManifest();
  }
  const part = file.slice(offset, offset + length);
  if (part.size !== length) {
    return invalidManifest();
  }
  const bytes = new Uint8Array(await part.arrayBuffer());
  return bytes.byteLength === length ? bytes : invalidManifest();
}

class BlobStreamReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private bufferOffset = 0;
  private consumed = 0;

  constructor(private readonly blob: Blob) {
    this.reader = blob.stream().getReader();
  }

  async read(length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.consumed + length > this.blob.size
    ) {
      return invalidManifest();
    }

    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (this.bufferOffset === this.buffer.byteLength) {
        const next = await this.reader.read();
        if (next.done) {
          return invalidManifest();
        }
        this.buffer = next.value;
        this.bufferOffset = 0;
      }

      const count = Math.min(
        length - written,
        this.buffer.byteLength - this.bufferOffset,
      );
      result.set(
        this.buffer.subarray(this.bufferOffset, this.bufferOffset + count),
        written,
      );
      this.bufferOffset += count;
      written += count;
    }
    this.consumed += length;
    return result;
  }

  async skip(length: number): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      const count = Math.min(remaining, 64 * 1024);
      await this.read(count);
      remaining -= count;
    }
  }

  async finish(): Promise<void> {
    if (this.consumed !== this.blob.size) {
      return invalidManifest();
    }
    await this.reader.cancel();
  }
}

function decodeEntryName(nameBytes: Uint8Array, flags: number): string | null {
  const usesUtf8 = (flags & 0x800) !== 0;
  if (!usesUtf8 && nameBytes.some((byte) => byte > 0x7f)) {
    return null;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
  } catch {
    return invalidManifest();
  }
}

function normalizePotentialTargetPath(name: string): string | null {
  const path = name.replaceAll("\\", "/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      // Treat leading parent components as aliases too. They are not valid ZIP
      // paths, but collapsing them here makes a disguised target fail closed.
      if (segments.length > 0) segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

function isTargetPathVariant(name: string): boolean {
  if (name === analyticsManifestV1Path) {
    return false;
  }
  return normalizePotentialTargetPath(name)?.toLowerCase() ===
    analyticsManifestV1Path.toLowerCase();
}

function parseZip64Extra(
  extra: Uint8Array,
  needsOriginalSize: boolean,
  needsCompressedSize: boolean,
  needsLocalOffset: boolean,
  needsDisk: boolean,
): Readonly<{
  originalSize?: number;
  compressedSize?: number;
  localOffset?: number;
  disk?: number;
}> {
  let offset = 0;
  while (offset + 4 <= extra.byteLength) {
    const id = readUint16(extra, offset);
    const size = readUint16(extra, offset + 2);
    offset += 4;
    if (offset + size > extra.byteLength) {
      return invalidManifest();
    }
    if (id !== 1) {
      offset += size;
      continue;
    }

    const end = offset + size;
    const result: {
      originalSize?: number;
      compressedSize?: number;
      localOffset?: number;
      disk?: number;
    } = {};
    if (needsOriginalSize) {
      if (offset + 8 > end) return invalidManifest();
      result.originalSize = readUint64(extra, offset);
      offset += 8;
    }
    if (needsCompressedSize) {
      if (offset + 8 > end) return invalidManifest();
      result.compressedSize = readUint64(extra, offset);
      offset += 8;
    }
    if (needsLocalOffset) {
      if (offset + 8 > end) return invalidManifest();
      result.localOffset = readUint64(extra, offset);
      offset += 8;
    }
    if (needsDisk) {
      if (offset + 4 > end) return invalidManifest();
      result.disk = readUint32(extra, offset);
    }
    return result;
  }
  return invalidManifest();
}

async function readCentralDirectory(file: File): Promise<CentralDirectory> {
  const tailLength = Math.min(file.size, maximumEndRecordBytes);
  const tailOffset = file.size - tailLength;
  const tail = await readRange(file, tailOffset, tailLength);
  let relativeEndOffset = -1;
  for (let offset = tail.byteLength - 22; offset >= 0; offset--) {
    if (
      readUint32(tail, offset) === 0x06054b50 &&
      tailOffset + offset + 22 + readUint16(tail, offset + 20) === file.size
    ) {
      relativeEndOffset = offset;
      break;
    }
  }
  if (relativeEndOffset < 0) {
    return invalidManifest();
  }

  const endOffset = tailOffset + relativeEndOffset;
  const diskNumber = readUint16(tail, relativeEndOffset + 4);
  const centralDisk = readUint16(tail, relativeEndOffset + 6);
  const entriesOnDisk = readUint16(tail, relativeEndOffset + 8);
  const entries = readUint16(tail, relativeEndOffset + 10);
  const size = readUint32(tail, relativeEndOffset + 12);
  const offset = readUint32(tail, relativeEndOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entries) {
    return invalidManifest();
  }

  const usesZip64 =
    entries === 0xffff || size === 0xffffffff || offset === 0xffffffff;
  if (!usesZip64) {
    if (offset + size > endOffset || entries > Math.floor(size / 46)) {
      return invalidManifest();
    }
    return { offset, size, entries };
  }

  if (endOffset < 20) {
    return invalidManifest();
  }
  const locator = await readRange(file, endOffset - 20, 20);
  if (
    readUint32(locator, 0) !== 0x07064b50 ||
    readUint32(locator, 4) !== 0 ||
    readUint32(locator, 16) !== 1
  ) {
    return invalidManifest();
  }
  const zip64EndOffset = readUint64(locator, 8);
  const zip64Header = await readRange(file, zip64EndOffset, 56);
  if (
    readUint32(zip64Header, 0) !== 0x06064b50 ||
    readUint64(zip64Header, 4) < 44 ||
    readUint32(zip64Header, 16) !== 0 ||
    readUint32(zip64Header, 20) !== 0
  ) {
    return invalidManifest();
  }

  const zip64RecordSize = readUint64(zip64Header, 4) + 12;
  if (zip64EndOffset + zip64RecordSize !== endOffset - 20) {
    return invalidManifest();
  }
  const zip64EntriesOnDisk = readUint64(zip64Header, 24);
  const zip64Entries = readUint64(zip64Header, 32);
  const zip64Size = readUint64(zip64Header, 40);
  const zip64Offset = readUint64(zip64Header, 48);
  if (
    zip64EntriesOnDisk !== zip64Entries ||
    zip64Offset + zip64Size > zip64EndOffset ||
    zip64Entries > Math.floor(zip64Size / 46)
  ) {
    return invalidManifest();
  }
  return {
    offset: zip64Offset,
    size: zip64Size,
    entries: zip64Entries,
  };
}

async function walkCentralDirectory(
  file: File,
  directory: CentralDirectory,
  visit: (entry: CentralEntry) => void,
): Promise<void> {
  const reader = new BlobStreamReader(
    file.slice(directory.offset, directory.offset + directory.size),
  );
  for (let index = 0; index < directory.entries; index++) {
    const header = await reader.read(46);
    if (readUint32(header, 0) !== 0x02014b50) {
      return invalidManifest();
    }

    const flags = readUint16(header, 8);
    const compression = readUint16(header, 10);
    const crc32 = readUint32(header, 16);
    const reportedCompressedSize = readUint32(header, 20);
    const reportedOriginalSize = readUint32(header, 24);
    const nameLength = readUint16(header, 28);
    const extraLength = readUint16(header, 30);
    const commentLength = readUint16(header, 32);
    const reportedDisk = readUint16(header, 34);
    const reportedLocalOffset = readUint32(header, 42);
    const nameBytes = await reader.read(nameLength);
    const extra = await reader.read(extraLength);
    await reader.skip(commentLength);

    const needsOriginalSize = reportedOriginalSize === 0xffffffff;
    const needsCompressedSize = reportedCompressedSize === 0xffffffff;
    const needsLocalOffset = reportedLocalOffset === 0xffffffff;
    const needsDisk = reportedDisk === 0xffff;
    const zip64 =
      needsOriginalSize || needsCompressedSize || needsLocalOffset || needsDisk
        ? parseZip64Extra(
          extra,
          needsOriginalSize,
          needsCompressedSize,
          needsLocalOffset,
          needsDisk,
        )
        : {};
    const disk = zip64.disk ?? reportedDisk;
    const localHeaderOffset = zip64.localOffset ?? reportedLocalOffset;
    if (disk !== 0 || localHeaderOffset >= directory.offset) {
      return invalidManifest();
    }

    visit({
      name: decodeEntryName(nameBytes, flags),
      nameBytes,
      flags,
      compression,
      crc32,
      compressedSize: zip64.compressedSize ?? reportedCompressedSize,
      originalSize: zip64.originalSize ?? reportedOriginalSize,
      localHeaderOffset,
      zip64Sizes: needsOriginalSize || needsCompressedSize,
    });
  }
  await reader.finish();
}

async function findTargetEntry(
  file: File,
  directory: CentralDirectory,
): Promise<TargetEntry | null> {
  let target: TargetEntry | null = null;
  await walkCentralDirectory(file, directory, (entry) => {
    if (entry.name && isTargetPathVariant(entry.name)) {
      return invalidManifest();
    }
    if (entry.name !== analyticsManifestV1Path) {
      return;
    }
    if (target !== null) {
      return invalidManifest();
    }
    target = entry as TargetEntry;
  });
  return target;
}

async function findFollowingLocalHeaderOffset(
  file: File,
  directory: CentralDirectory,
  targetOffset: number,
): Promise<number> {
  let followingOffset = directory.offset;
  await walkCentralDirectory(file, directory, (entry) => {
    if (
      entry.localHeaderOffset > targetOffset &&
      entry.localHeaderOffset < followingOffset
    ) {
      followingOffset = entry.localHeaderOffset;
    }
  });
  return followingOffset;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}

function resolveLocalZip64Sizes(
  extra: Uint8Array,
  reportedOriginalSize: number,
  reportedCompressedSize: number,
): Readonly<{ originalSize: number; compressedSize: number }> {
  const needsOriginalSize = reportedOriginalSize === 0xffffffff;
  const needsCompressedSize = reportedCompressedSize === 0xffffffff;
  if (!needsOriginalSize && !needsCompressedSize) {
    return {
      originalSize: reportedOriginalSize,
      compressedSize: reportedCompressedSize,
    };
  }
  const zip64 = parseZip64Extra(
    extra,
    needsOriginalSize,
    needsCompressedSize,
    false,
    false,
  );
  return {
    originalSize: zip64.originalSize ?? reportedOriginalSize,
    compressedSize: zip64.compressedSize ?? reportedCompressedSize,
  };
}

async function validateLocalHeader(
  file: File,
  target: TargetEntry,
  boundary: number,
): Promise<number> {
  const header = await readRange(file, target.localHeaderOffset, 30);
  if (readUint32(header, 0) !== 0x04034b50) {
    return invalidManifest();
  }
  const flags = readUint16(header, 6);
  const compression = readUint16(header, 8);
  const localCrc32 = readUint32(header, 14);
  const reportedCompressedSize = readUint32(header, 18);
  const reportedOriginalSize = readUint32(header, 22);
  const nameLength = readUint16(header, 26);
  const extraLength = readUint16(header, 28);
  const variable = await readRange(
    file,
    target.localHeaderOffset + 30,
    nameLength + extraLength,
  );
  const nameBytes = variable.subarray(0, nameLength);
  const extra = variable.subarray(nameLength);
  const dataOffset = target.localHeaderOffset + 30 + variable.byteLength;
  const usesDescriptor = (flags & 8) !== 0;
  if (
    flags !== target.flags ||
    compression !== target.compression ||
    (flags & 1) !== 0 ||
    (compression !== 0 && compression !== 8) ||
    !bytesEqual(nameBytes, targetNameBytes) ||
    target.compressedSize > maximumTargetCompressedBytes ||
    dataOffset + target.compressedSize > boundary
  ) {
    return invalidManifest();
  }

  if (!usesDescriptor) {
    const localSizes = resolveLocalZip64Sizes(
      extra,
      reportedOriginalSize,
      reportedCompressedSize,
    );
    if (
      localCrc32 !== target.crc32 ||
      localSizes.compressedSize !== target.compressedSize ||
      localSizes.originalSize !== target.originalSize
    ) {
      return invalidManifest();
    }
  }
  return dataOffset;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value++) {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[value] = crc >>> 0;
  }
  return table;
})();

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let result = crc;
  for (const byte of bytes) {
    result = crcTable[(result ^ byte) & 0xff] ^ (result >>> 8);
  }
  return result >>> 0;
}

async function expandTargetEntry(
  file: File,
  target: TargetEntry,
  dataOffset: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let outputBytes = 0;
  let crc = 0xffffffff;
  let failed = false;
  let inflaterFinished = target.compression === 0;
  const onOutput = (chunk: Uint8Array, final: boolean): void => {
    outputBytes += chunk.byteLength;
    if (outputBytes > analyticsManifestV1MaxBytes) {
      failed = true;
      return;
    }
    crc = updateCrc32(crc, chunk);
    chunks.push(chunk.slice());
    if (final) {
      inflaterFinished = true;
    }
  };
  const inflater = target.compression === 8 ? new Inflate(onOutput) : null;
  const stream = file
    .slice(dataOffset, dataOffset + target.compressedSize)
    .stream();
  const reader = stream.getReader();
  let inputBytes = 0;

  try {
    while (!failed) {
      const next = await reader.read();
      if (next.done) break;
      inputBytes += next.value.byteLength;
      if (inputBytes > target.compressedSize) {
        failed = true;
        break;
      }
      if (inflater) {
        for (let offset = 0; offset < next.value.byteLength && !failed;) {
          const end = Math.min(
            offset + inflateInputChunkBytes,
            next.value.byteLength,
          );
          inflater.push(
            next.value.subarray(offset, end),
            inputBytes - next.value.byteLength + end === target.compressedSize,
          );
          offset = end;
        }
      } else {
        onOutput(next.value, inputBytes === target.compressedSize);
      }
    }
  } catch {
    failed = true;
  } finally {
    await reader.cancel();
  }

  const actualCrc32 = (crc ^ 0xffffffff) >>> 0;
  if (
    failed ||
    inputBytes !== target.compressedSize ||
    !inflaterFinished ||
    outputBytes !== target.originalSize ||
    actualCrc32 !== target.crc32
  ) {
    return invalidManifest();
  }

  const content = new Uint8Array(outputBytes);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

async function validateDataDescriptor(
  file: File,
  target: TargetEntry,
  descriptorOffset: number,
  boundary: number,
): Promise<void> {
  if ((target.flags & 8) === 0) {
    return;
  }
  const zip64 = target.zip64Sizes;
  const unsignedLength = zip64 ? 20 : 12;
  const signedLength = unsignedLength + 4;
  const available = boundary - descriptorOffset;
  if (available < unsignedLength) {
    return invalidManifest();
  }
  const descriptor = await readRange(
    file,
    descriptorOffset,
    Math.min(available, signedLength),
  );
  const hasSignature = available === signedLength &&
    readUint32(descriptor, 0) === 0x08074b50;
  const offset = hasSignature ? 4 : 0;
  if (
    available !== offset + unsignedLength ||
    descriptor.byteLength !== offset + unsignedLength
  ) {
    return invalidManifest();
  }
  const crc32 = readUint32(descriptor, offset);
  const compressedSize = zip64
    ? readUint64(descriptor, offset + 4)
    : readUint32(descriptor, offset + 4);
  const originalSize = zip64
    ? readUint64(descriptor, offset + 12)
    : readUint32(descriptor, offset + 8);
  if (
    crc32 !== target.crc32 ||
    compressedSize !== target.compressedSize ||
    originalSize !== target.originalSize
  ) {
    return invalidManifest();
  }
}

async function extractAnalyticsManifest(
  file: File,
  directory: CentralDirectory,
  target: TargetEntry,
): Promise<Uint8Array> {
  const boundary = await findFollowingLocalHeaderOffset(
    file,
    directory,
    target.localHeaderOffset,
  );
  const dataOffset = await validateLocalHeader(file, target, boundary);
  const content = await expandTargetEntry(file, target, dataOffset);
  await validateDataDescriptor(
    file,
    target,
    dataOffset + target.compressedSize,
    boundary,
  );
  return content;
}

async function sha256Hex(content: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", content);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Returns the approved manifest digest for a package archive, or null when a
 * legacy archive deliberately has no v1 analytics manifest. Archive access is
 * random-access and only the exact manifest entry is ever decompressed.
 */
export async function inspectPackageAnalyticsManifest(
  file: File,
): Promise<string | null> {
  if (!isNuGetPackage(file)) {
    return null;
  }
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > marketplacePackageMaxBytes
  ) {
    return invalidManifest();
  }

  try {
    const directory = await readCentralDirectory(file);
    const target = await findTargetEntry(file, directory);
    if (!target) {
      return null;
    }
    const content = await extractAnalyticsManifest(file, directory, target);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(content);
    parseAnalyticsManifestV1Json(source);
    return await sha256Hex(content);
  } catch (error) {
    if (error instanceof PackageAnalyticsManifestError) {
      throw error;
    }
    return invalidManifest();
  }
}
