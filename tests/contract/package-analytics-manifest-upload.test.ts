import { describe, expect, it } from "vitest";
import { deflateSync, Zip, ZipDeflate, zipSync } from "fflate";
import {
  analyticsManifestV1MaxBytes,
  analyticsManifestV1Path,
  analyticsManifestV1MaxTypeIdentifierCharacters,
} from "@beutl/core";
import {
  inspectPackageAnalyticsManifest,
  marketplacePackageMaxBytes,
  PackageAnalyticsManifestError,
} from "@/lib/analytics-manifest";

const encoder = new TextEncoder();

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function uint16(value: number): Uint8Array {
  const result = new Uint8Array(2);
  new DataView(result.buffer).setUint16(0, value, true);
  return result;
}

function uint32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value >>> 0, true);
  return result;
}

function uint64(value: number): Uint8Array {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, BigInt(value), true);
  return result;
}

function crc32(content: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader({
  version,
  flags,
  compression,
  crc,
  compressedSize,
  originalSize,
  name,
  extra = new Uint8Array(0),
}: {
  version: number;
  flags: number;
  compression: number;
  crc: number;
  compressedSize: number;
  originalSize: number;
  name: Uint8Array;
  extra?: Uint8Array;
}): Uint8Array {
  const fixed = new Uint8Array(30);
  const view = new DataView(fixed.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, version, true);
  view.setUint16(6, flags, true);
  view.setUint16(8, compression, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, compressedSize, true);
  view.setUint32(22, originalSize, true);
  view.setUint16(26, name.byteLength, true);
  view.setUint16(28, extra.byteLength, true);
  return concatBytes(fixed, name, extra);
}

function centralHeader({
  version,
  flags,
  compression,
  crc,
  compressedSize,
  originalSize,
  localOffset,
  name,
  extra = new Uint8Array(0),
}: {
  version: number;
  flags: number;
  compression: number;
  crc: number;
  compressedSize: number;
  originalSize: number;
  localOffset: number;
  name: Uint8Array;
  extra?: Uint8Array;
}): Uint8Array {
  const fixed = new Uint8Array(46);
  const view = new DataView(fixed.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, version, true);
  view.setUint16(6, version, true);
  view.setUint16(8, flags, true);
  view.setUint16(10, compression, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, compressedSize, true);
  view.setUint32(24, originalSize, true);
  view.setUint16(28, name.byteLength, true);
  view.setUint16(30, extra.byteLength, true);
  view.setUint32(42, localOffset, true);
  return concatBytes(fixed, name, extra);
}

function classicEnd(centralOffset: number, centralSize: number): Uint8Array {
  const result = new Uint8Array(22);
  const view = new DataView(result.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, 1, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  return result;
}

function createDataDescriptorPackage(corruptDescriptor = false): File {
  const name = encoder.encode(analyticsManifestV1Path);
  const content = encoder.encode(validManifest());
  const compressed = deflateSync(content);
  const checksum = crc32(content);
  const flags = 0x808;
  const local = localHeader({
    version: 20,
    flags,
    compression: 8,
    crc: 0,
    compressedSize: 0,
    originalSize: 0,
    name,
  });
  const descriptor = concatBytes(
    uint32(0x08074b50),
    uint32(corruptDescriptor ? checksum ^ 1 : checksum),
    uint32(compressed.byteLength),
    uint32(content.byteLength),
  );
  const centralOffset = local.byteLength + compressed.byteLength +
    descriptor.byteLength;
  const central = centralHeader({
    version: 20,
    flags,
    compression: 8,
    crc: checksum,
    compressedSize: compressed.byteLength,
    originalSize: content.byteLength,
    localOffset: 0,
    name,
  });
  return new File(
    [
      local,
      compressed,
      descriptor,
      central,
      classicEnd(centralOffset, central.byteLength),
    ],
    "descriptor.nupkg",
  );
}

function createZip64Package(corruptLocator = false): File {
  const name = encoder.encode(analyticsManifestV1Path);
  const content = encoder.encode(validManifest());
  const checksum = crc32(content);
  const localExtra = concatBytes(
    uint16(1),
    uint16(16),
    uint64(content.byteLength),
    uint64(content.byteLength),
  );
  const local = localHeader({
    version: 45,
    flags: 0x800,
    compression: 0,
    crc: checksum,
    compressedSize: 0xffffffff,
    originalSize: 0xffffffff,
    name,
    extra: localExtra,
  });
  const centralOffset = local.byteLength + content.byteLength;
  const centralExtra = concatBytes(
    uint16(1),
    uint16(24),
    uint64(content.byteLength),
    uint64(content.byteLength),
    uint64(0),
  );
  const central = centralHeader({
    version: 45,
    flags: 0x800,
    compression: 0,
    crc: checksum,
    compressedSize: 0xffffffff,
    originalSize: 0xffffffff,
    localOffset: 0xffffffff,
    name,
    extra: centralExtra,
  });
  const zip64EndOffset = centralOffset + central.byteLength;
  const zip64End = concatBytes(
    uint32(0x06064b50),
    uint64(44),
    uint16(45),
    uint16(45),
    uint32(0),
    uint32(0),
    uint64(1),
    uint64(1),
    uint64(central.byteLength),
    uint64(centralOffset),
  );
  const locator = concatBytes(
    uint32(corruptLocator ? 0 : 0x07064b50),
    uint32(0),
    uint64(zip64EndOffset),
    uint32(1),
  );
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 0xffff, true);
  endView.setUint16(10, 0xffff, true);
  endView.setUint32(12, 0xffffffff, true);
  endView.setUint32(16, 0xffffffff, true);
  return new File(
    [local, content, central, zip64End, locator, end],
    "zip64.nupkg",
  );
}

type PackageEntry = readonly [name: string, content: string | Uint8Array];

function asBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? encoder.encode(content) : content;
}

function createPackage(entries: Record<string, string | Uint8Array>): File {
  return new File(
    [
      zipSync(
        Object.fromEntries(
          Object.entries(entries).map(([name, content]) => [
            name,
            asBytes(content),
          ]),
        ),
      ),
    ],
    "example.extension.nupkg",
    { type: "application/octet-stream" },
  );
}

function createPackageWithDuplicateNames(entries: readonly PackageEntry[]): File {
  const chunks: Uint8Array[] = [];
  let archiveError: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) {
      archiveError = error;
      return;
    }
    chunks.push(chunk.slice());
  });
  const streams = entries.map(([name]) => new ZipDeflate(name, { level: 6 }));
  for (const stream of streams) {
    zip.add(stream);
  }
  entries.forEach(([, content], index) => {
    streams[index].push(asBytes(content), true);
  });
  zip.end();
  if (archiveError) {
    throw archiveError;
  }

  return new File(chunks, "duplicates.nupkg");
}

function underReportOriginalSize(file: File): Promise<File> {
  return file.arrayBuffer().then((buffer) => {
    const archive = new Uint8Array(buffer);
    const view = new DataView(archive.buffer);
    for (let offset = 0; offset <= archive.byteLength - 30; offset++) {
      const signature = view.getUint32(offset, true);
      if (signature === 0x04034b50) {
        view.setUint32(offset + 22, 1, true);
      } else if (signature === 0x02014b50) {
        view.setUint32(offset + 24, 1, true);
      }
    }
    return new File([archive], file.name);
  });
}

async function corruptUtf8EntryName(file: File): Promise<File> {
  const archive = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  for (let offset = 0; offset <= archive.byteLength - 30; offset++) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) {
      view.setUint16(offset + 6, view.getUint16(offset + 6, true) | 0x800, true);
      archive[offset + 30] = 0xff;
    } else if (signature === 0x02014b50) {
      view.setUint16(offset + 8, view.getUint16(offset + 8, true) | 0x800, true);
      archive[offset + 46] = 0xff;
    }
  }
  return new File([archive], file.name);
}

function createVirtualLargeLegacyPackage(): {
  file: File;
  largestSlice: () => number;
} {
  const template = zipSync({ "runtimes/native/resource.bin": new Uint8Array(1) }, {
    level: 0,
  });
  const view = new DataView(template.buffer, template.byteOffset, template.byteLength);
  let centralOffset = -1;
  let endOffset = -1;
  for (let offset = 0; offset <= template.byteLength - 4; offset++) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x02014b50 && centralOffset < 0) centralOffset = offset;
    if (signature === 0x06054b50) endOffset = offset;
  }
  if (centralOffset < 0 || endOffset < 0) throw new Error("Invalid ZIP fixture");

  const central = template.slice(centralOffset, endOffset);
  const centralView = new DataView(central.buffer, central.byteOffset, central.byteLength);
  centralView.setUint32(20, 128 * 1024 * 1024, true);
  centralView.setUint32(24, 128 * 1024 * 1024, true);
  const end = template.slice(endOffset, endOffset + 22);
  const endView = new DataView(end.buffer, end.byteOffset, end.byteLength);
  const size = 160 * 1024 * 1024;
  const virtualCentralOffset = size - central.byteLength - end.byteLength;
  endView.setUint32(12, central.byteLength, true);
  endView.setUint32(16, virtualCentralOffset, true);
  const segments = [
    { offset: virtualCentralOffset, bytes: central },
    { offset: virtualCentralOffset + central.byteLength, bytes: end },
  ];
  let maximumSlice = 0;
  const file = {
    name: "large-legacy.nupkg",
    size,
    slice(start = 0, finish = size) {
      maximumSlice = Math.max(maximumSlice, finish - start);
      const bytes = new Uint8Array(finish - start);
      for (const segment of segments) {
        const overlapStart = Math.max(start, segment.offset);
        const overlapEnd = Math.min(finish, segment.offset + segment.bytes.byteLength);
        if (overlapStart < overlapEnd) {
          bytes.set(
            segment.bytes.subarray(
              overlapStart - segment.offset,
              overlapEnd - segment.offset,
            ),
            overlapStart - start,
          );
        }
      }
      return new Blob([bytes]);
    },
  } as File;
  return { file, largestSlice: () => maximumSlice };
}

function validManifest(): string {
  return JSON.stringify({
    schemaVersion: 1,
    features: [
      {
        kind: "effect",
        key: "color-grade",
        types: [
          {
            assembly: "Example.Extension",
            type: "Example.Extension.ColorGrade",
          },
        ],
      },
    ],
  });
}

function manifestWithIdentifier(
  field: "assembly" | "type",
  length: number,
): string {
  const manifest = JSON.parse(validManifest()) as {
    features: Array<{
      types: Array<{ assembly: string; type: string }>;
    }>;
  };
  manifest.features[0].types[0][field] = `A${"a".repeat(length - 1)}`;
  return JSON.stringify(manifest);
}

async function expectInvalid(file: File): Promise<void> {
  await expect(inspectPackageAnalyticsManifest(file)).rejects.toBeInstanceOf(
    PackageAnalyticsManifestError,
  );
}

describe("package analytics manifest upload validation", () => {
  it("accepts an optional valid manifest and returns its SHA-256", async () => {
    const manifest = validManifest();
    const result = await inspectPackageAnalyticsManifest(
      createPackage({ [analyticsManifestV1Path]: manifest }),
    );

    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts valid ZIP64 and signed data-descriptor target entries", async () => {
    await expect(inspectPackageAnalyticsManifest(createZip64Package()))
      .resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(
      inspectPackageAnalyticsManifest(createDataDescriptorPackage()),
    ).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects corrupt ZIP64 locators and data descriptors", async () => {
    await expectInvalid(createZip64Package(true));
    await expectInvalid(createDataDescriptorPackage(true));
  });

  it("keeps legacy packages compatible when the manifest is absent", async () => {
    await expect(
      inspectPackageAnalyticsManifest(
        createPackage({ "lib/net10.0/Example.Extension.dll": "binary" }),
      ),
    ).resolves.toBeNull();
  });

  it("rejects invalid, oversized, corrupt, and invalid UTF-8 manifests", async () => {
    await expectInvalid(
      createPackage({ [analyticsManifestV1Path]: "{not json}" }),
    );
    await expectInvalid(
      createPackage({
        [analyticsManifestV1Path]:
          `${validManifest()}${" ".repeat(analyticsManifestV1MaxBytes)}`,
      }),
    );
    await expectInvalid(
      new File([new Uint8Array([1, 2, 3])], "corrupt.nupkg"),
    );
    await expectInvalid(
      createPackage({
        [analyticsManifestV1Path]: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]),
      }),
    );
  });

  it("enforces the archive size before reading its contents", async () => {
    let read = false;
    const oversized = {
      name: "oversized.nupkg",
      size: marketplacePackageMaxBytes + 1,
      async arrayBuffer() {
        read = true;
        return new ArrayBuffer(0);
      },
    } as File;

    await expectInvalid(oversized);
    expect(read).toBe(false);
  });

  it("uses actual decompressed bytes instead of reported original sizes", async () => {
    const oversizedManifest = createPackage({
      [analyticsManifestV1Path]:
        `${validManifest()}${" ".repeat(analyticsManifestV1MaxBytes)}`,
    });

    await expectInvalid(await underReportOriginalSize(oversizedManifest));
  });

  it("rejects malformed UTF-8 entry names fail-closed", async () => {
    await expectInvalid(
      await corruptUtf8EntryName(
        createPackage({ [analyticsManifestV1Path]: validManifest() }),
      ),
    );
  });

  it.each(["assembly", "type"] as const)(
    "never approves a manifest whose %s exceeds 256 characters",
    async (field) => {
      await expect(
        inspectPackageAnalyticsManifest(
          createPackage({
            [analyticsManifestV1Path]: manifestWithIdentifier(
              field,
              analyticsManifestV1MaxTypeIdentifierCharacters,
            ),
          }),
        ),
      ).resolves.toMatch(/^[a-f0-9]{64}$/);
      await expectInvalid(
        createPackage({
          [analyticsManifestV1Path]: manifestWithIdentifier(
            field,
            analyticsManifestV1MaxTypeIdentifierCharacters + 1,
          ),
        }),
      );
    },
  );

  it("does not decompress high-ratio non-target entries", async () => {
    await expect(
      inspectPackageAnalyticsManifest(
      createPackage({ "lib/compression-bomb.bin": new Uint8Array(2 * 1024 * 1024) }),
      ),
    ).resolves.toBeNull();
  });

  it("accepts normal archives with more than 4,096 entries", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 4097 }, (_, index) => [
        `lib/${index}.bin`,
        new Uint8Array(0),
      ]),
    );
    await expect(inspectPackageAnalyticsManifest(createPackage(entries)))
      .resolves.toBeNull();
  });

  it("uses bounded random access for large legacy resource packages", async () => {
    const fixture = createVirtualLargeLegacyPackage();

    await expect(inspectPackageAnalyticsManifest(fixture.file)).resolves.toBeNull();
    expect(fixture.largestSlice()).toBeLessThanOrEqual(22 + 0xffff);
  });

  it("rejects path variants and duplicate manifest entries", async () => {
    for (const path of [
      `./${analyticsManifestV1Path}`,
      analyticsManifestV1Path.replace("/", "//"),
      analyticsManifestV1Path.replaceAll("/", "\\"),
      "Beutl/analytics-features.v1.json",
      `../${analyticsManifestV1Path}`,
    ]) {
      await expectInvalid(createPackage({ [path]: validManifest() }));
    }

    await expectInvalid(
      createPackageWithDuplicateNames([
        [analyticsManifestV1Path, validManifest()],
        [analyticsManifestV1Path, validManifest()],
      ]),
    );
  });

  it.each([
    ["schemaVersion", '"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'],
    ["features", '"features":[', '"features":[],"features":['],
    ["kind", '"kind":"effect"', '"kind":"effect","kind":"effect"'],
    ["key", '"key":"color-grade"', '"key":"color-grade","key":"color-grade"'],
    ["types", '"types":[', '"types":[],"types":['],
    [
      "assembly",
      '"assembly":"Example.Extension"',
      '"assembly":"Example.Extension","assembly":"Example.Extension"',
    ],
    [
      "type",
      '"type":"Example.Extension.ColorGrade"',
      '"type":"Example.Extension.ColorGrade","type":"Example.Extension.ColorGrade"',
    ],
  ])("rejects duplicate %s JSON members", async (_name, needle, replacement) => {
    const duplicate = validManifest().replace(needle, replacement);
    await expectInvalid(createPackage({ [analyticsManifestV1Path]: duplicate }));
  });

  it("rejects duplicate members whose escaped names decode identically", async () => {
    const duplicate = validManifest().replace(
      '"kind":"effect"',
      '"kind":"effect","k\\u0069nd":"effect"',
    );
    await expectInvalid(createPackage({ [analyticsManifestV1Path]: duplicate }));
  });
});
