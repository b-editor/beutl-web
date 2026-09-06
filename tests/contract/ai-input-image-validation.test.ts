import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  validateAiInputImage,
  type AiInputImageMimeType,
} from "../../packages/api/src/ai/input-image-validation";

const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const ALL_IMAGE_TYPES = new Set<AiInputImageMimeType>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

type IndexedBitDepth = 1 | 2 | 4 | 8;

type IndexedPngOptions = {
  width?: number;
  height?: number;
  bitDepth?: IndexedBitDepth;
  paletteEntries?: number;
  pixels?: number[][];
  interlace?: 0 | 1;
  filters?: number[];
  paletteData?: Uint8Array;
  includePalette?: boolean;
  paletteAfterIdat?: boolean;
  duplicatePalette?: boolean;
  decodedData?: Uint8Array;
  compressedData?: Uint8Array;
};

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const ADAM7_PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) === 1
        ? 0xedb88320 ^ (crc >>> 1)
        : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(12 + data.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(new TextEncoder().encode(type), 4);
  result.set(data, 8);
  view.setUint32(8 + data.length, crc32(result.subarray(4, 8 + data.length)));
  return result;
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function packIndexedRow(
  samples: number[],
  bitDepth: IndexedBitDepth,
): Uint8Array {
  const packed = new Uint8Array(Math.ceil((samples.length * bitDepth) / 8));
  const mask = (1 << bitDepth) - 1;
  for (const [index, sample] of samples.entries()) {
    if (sample < 0 || sample > mask) {
      throw new Error("Indexed PNG fixture sample does not fit its bit depth");
    }
    const bitOffset = index * bitDepth;
    const shift = 8 - bitDepth - (bitOffset % 8);
    packed[Math.floor(bitOffset / 8)] |= sample << shift;
  }
  return packed;
}

function filterIndexedRow(
  row: Uint8Array,
  previous: Uint8Array | null,
  filter: number,
): Uint8Array {
  const filtered = new Uint8Array(row.length);
  for (let index = 0; index < row.length; index++) {
    const left = index > 0 ? row[index - 1] : 0;
    const above = previous?.[index] ?? 0;
    const upperLeft = index > 0 ? previous?.[index - 1] ?? 0 : 0;
    let predictor = 0;
    switch (filter) {
      case 1:
        predictor = left;
        break;
      case 2:
        predictor = above;
        break;
      case 3:
        predictor = Math.floor((left + above) / 2);
        break;
      case 4:
        predictor = paethPredictor(left, above, upperLeft);
        break;
    }
    filtered[index] = (row[index] - predictor + 256) & 0xff;
  }
  return filtered;
}

function indexedScanlines(
  width: number,
  height: number,
  bitDepth: IndexedBitDepth,
  pixels: number[][],
  interlace: 0 | 1,
  filters: number[],
): Uint8Array {
  const bytes: number[] = [];
  const passes = interlace === 1
    ? ADAM7_PASSES
    : [[0, 0, 1, 1] as const];
  let scanline = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    if (width <= startX || height <= startY) continue;
    let previous: Uint8Array | null = null;
    for (let y = startY; y < height; y += stepY) {
      const samples: number[] = [];
      for (let x = startX; x < width; x += stepX) {
        samples.push(pixels[y][x]);
      }
      const row = packIndexedRow(samples, bitDepth);
      const filter = filters[scanline % filters.length];
      bytes.push(filter, ...filterIndexedRow(row, previous, filter));
      previous = row;
      scanline++;
    }
  }
  return Uint8Array.from(bytes);
}

function indexedPng(options: IndexedPngOptions = {}): Uint8Array {
  const width = options.width ?? 1;
  const height = options.height ?? 1;
  const bitDepth = options.bitDepth ?? 8;
  const paletteEntries = options.paletteEntries ?? 1;
  const interlace = options.interlace ?? 0;
  const pixels = options.pixels ?? Array.from(
    { length: height },
    () => Array.from({ length: width }, () => 0),
  );
  const filters = options.filters ?? [0];
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = bitDepth;
  header[9] = 3;
  header[12] = interlace;

  const palette = options.paletteData ?? new Uint8Array(paletteEntries * 3);
  const decoded = options.decodedData ?? indexedScanlines(
    width,
    height,
    bitDepth,
    pixels,
    interlace,
    filters,
  );
  const compressed = options.compressedData ?? Uint8Array.from(
    deflateSync(decoded),
  );
  const parts = [PNG_SIGNATURE, pngChunk("IHDR", header)];
  if (options.includePalette !== false && !options.paletteAfterIdat) {
    parts.push(pngChunk("PLTE", palette));
    if (options.duplicatePalette) parts.push(pngChunk("PLTE", palette));
  }
  parts.push(pngChunk("IDAT", compressed));
  if (options.includePalette !== false && options.paletteAfterIdat) {
    parts.push(pngChunk("PLTE", palette));
  }
  parts.push(pngChunk("IEND", new Uint8Array()));
  return concatenate(parts);
}

async function validatePng(bytes: Uint8Array) {
  return await validateAiInputImage(
    new File([bytes], "indexed.png", { type: "image/png" }),
    ALL_IMAGE_TYPES,
  );
}

describe("AI input image validation", () => {
  it("cancels PNG decompression and propagates the abort reason", async () => {
    const controller = new AbortController();
    const reason = new DOMException("page reloaded", "AbortError");
    let markReadStarted: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let markCancelled: (reason: unknown) => void;
    const cancelled = new Promise<unknown>((resolve) => {
      markCancelled = resolve;
    });

    class BlockingDecompressionStream {
      readonly readable = new ReadableStream<Uint8Array>({
        pull() {
          markReadStarted();
        },
        cancel(cancelReason) {
          markCancelled(cancelReason);
        },
      });

      readonly writable = new WritableStream<Uint8Array>();
    }

    vi.stubGlobal("DecompressionStream", BlockingDecompressionStream);
    try {
      const pending = validateAiInputImage(
        new File([PNG_BYTES], "frame.png", { type: "image/png" }),
        ALL_IMAGE_TYPES,
        controller.signal,
      );
      await readStarted;

      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
      await expect(cancelled).resolves.toBe(reason);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns fully validated bytes and the sniffed MIME type", async () => {
    const file = new File([PNG_BYTES], "frame.png", { type: "image/png" });

    const result = await validateAiInputImage(file, ALL_IMAGE_TYPES);

    expect(result?.mimeType).toBe("image/png");
    expect(new Uint8Array(result?.bytes ?? new ArrayBuffer(0))).toEqual(PNG_BYTES);
  });

  it.each([
    ["declared MIME", "frame.png", "image/jpeg"],
    ["known extension", "frame.jpg", "image/png"],
    ["unknown extension", "frame.exe", "image/png"],
  ])("rejects a mismatched %s", async (_, filename, type) => {
    await expect(
      validateAiInputImage(
        new File([PNG_BYTES], filename, { type }),
        ALL_IMAGE_TYPES,
      ),
    ).resolves.toBeNull();
  });

  it("accepts an extensionless file after byte validation", async () => {
    await expect(
      validateAiInputImage(
        new File([PNG_BYTES], "frame", { type: "" }),
        ALL_IMAGE_TYPES,
      ),
    ).resolves.toMatchObject({ mimeType: "image/png" });
  });

  it.each([1, 2, 4, 8] as const)(
    "accepts a valid indexed PNG at %i-bit depth",
    async (bitDepth) => {
      const paletteEntries = 2 ** bitDepth;
      const pixels = Array.from(
        { length: 2 },
        (_, y) => Array.from(
          { length: 17 },
          (_, x) => (x + y) % paletteEntries,
        ),
      );

      await expect(validatePng(indexedPng({
        width: 17,
        height: 2,
        bitDepth,
        paletteEntries,
        pixels,
        filters: [0, 1],
      }))).resolves.toMatchObject({ mimeType: "image/png" });
    },
  );

  it("accepts indexed scanlines using every PNG filter", async () => {
    const pixels = Array.from(
      { length: 5 },
      (_, y) => Array.from({ length: 6 }, (_, x) => (x + y) % 4),
    );

    await expect(validatePng(indexedPng({
      width: 6,
      height: 5,
      bitDepth: 8,
      paletteEntries: 4,
      pixels,
      filters: [0, 1, 2, 3, 4],
    }))).resolves.toMatchObject({ mimeType: "image/png" });
  });

  it("accepts an Adam7 indexed PNG and resets filters between passes", async () => {
    const pixels = Array.from(
      { length: 9 },
      (_, y) => Array.from({ length: 9 }, (_, x) => (x + y) % 8),
    );

    await expect(validatePng(indexedPng({
      width: 9,
      height: 9,
      bitDepth: 4,
      paletteEntries: 8,
      pixels,
      interlace: 1,
      filters: [0, 1, 2, 3, 4],
    }))).resolves.toMatchObject({ mimeType: "image/png" });
  });

  it.each([
    [1, 1],
    [2, 3],
    [4, 15],
    [8, 255],
  ] as const)(
    "rejects an out-of-range palette index at %i-bit depth",
    async (bitDepth, paletteEntries) => {
      await expect(validatePng(indexedPng({
        bitDepth,
        paletteEntries,
        pixels: [[paletteEntries]],
      }))).resolves.toBeNull();
    },
  );

  it.each([0, 1, 2, 3, 4])(
    "rejects an out-of-range index after reversing filter %i",
    async (filter) => {
      await expect(validatePng(indexedPng({
        width: 3,
        height: 2,
        bitDepth: 8,
        paletteEntries: 3,
        pixels: [
          [0, 1, 2],
          [0, 1, 3],
        ],
        filters: [0, filter],
      }))).resolves.toBeNull();
    },
  );

  it("rejects an out-of-range index in a later Adam7 pass", async () => {
    const pixels = Array.from(
      { length: 9 },
      () => Array.from({ length: 9 }, () => 0),
    );
    pixels[7][8] = 3;

    await expect(validatePng(indexedPng({
      width: 9,
      height: 9,
      bitDepth: 2,
      paletteEntries: 3,
      pixels,
      interlace: 1,
      filters: [0, 1, 2, 3, 4],
    }))).resolves.toBeNull();
  });

  it.each([
    ["a missing PLTE", { includePalette: false }],
    ["an empty PLTE", { paletteData: new Uint8Array() }],
    ["a partial PLTE entry", { paletteData: new Uint8Array(4) }],
    [
      "too many PLTE entries for the bit depth",
      { bitDepth: 1 as const, paletteData: new Uint8Array(9) },
    ],
    ["duplicate PLTE chunks", { duplicatePalette: true }],
    ["a PLTE after IDAT", { paletteAfterIdat: true }],
  ])("rejects an indexed PNG with %s", async (_, options) => {
    await expect(
      validatePng(indexedPng(options)),
    ).resolves.toBeNull();
  });

  it.each([
    ["an invalid filter", { decodedData: Uint8Array.from([5, 0]) }],
    ["an incomplete scanline", { decodedData: Uint8Array.from([0]) }],
    ["excess scanline data", { decodedData: Uint8Array.from([0, 0, 0]) }],
    ["a corrupt zlib stream", { compressedData: Uint8Array.from([1, 2, 3]) }],
  ])("rejects an indexed PNG with %s", async (_, options) => {
    await expect(
      validatePng(indexedPng(options)),
    ).resolves.toBeNull();
  });

  it("rejects valid bytes when that route does not support the format", async () => {
    await expect(
      validateAiInputImage(
        new File([PNG_BYTES], "frame.png", { type: "image/png" }),
        new Set<AiInputImageMimeType>(["image/jpeg"]),
      ),
    ).resolves.toBeNull();
  });

  it("rejects trailing polyglot content", async () => {
    const polyglot = new Uint8Array(PNG_BYTES.length + 5);
    polyglot.set(PNG_BYTES);
    polyglot.set(new TextEncoder().encode("<svg>"), PNG_BYTES.length);

    await expect(
      validateAiInputImage(
        new File([polyglot], "frame.png", { type: "image/png" }),
        ALL_IMAGE_TYPES,
      ),
    ).resolves.toBeNull();
  });

  it.each([
    ["JPEG", Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg", "x.jpg"],
    [
      "WebP",
      Uint8Array.from([
        0x52, 0x49, 0x46, 0x46, 0x0c, 0, 0, 0,
        0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
        0, 0, 0, 0,
      ]),
      "image/webp",
      "x.webp",
    ],
    [
      "GIF",
      Uint8Array.from([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b,
      ]),
      "image/gif",
      "x.gif",
    ],
  ])("rejects a header-only %s", async (_, bytes, type, filename) => {
    await expect(
      validateAiInputImage(
        new File([bytes], filename, { type }),
        ALL_IMAGE_TYPES,
      ),
    ).resolves.toBeNull();
  });
});
