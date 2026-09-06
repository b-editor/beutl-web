export const MAX_AI_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_AI_GENERATED_IMAGE_DIMENSION = 8_192;
export const MAX_AI_GENERATED_IMAGE_PIXELS = 16_777_216;

const MAX_PNG_DECODED_BYTES = 64 * 1024 * 1024;
// Workers expose streaming DEFLATE but no portable JPEG/WebP pixel decoder.
// Provider requests therefore require PNG, whose chunks, CRCs, decompressed
// scanlines, filters, and dimensions can all be verified in this runtime.
const GENERATED_IMAGE_MIME_TYPE = "image/png" as const;

export class InvalidGeneratedImageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidGeneratedImageError";
  }
}

export type ImageMetadata = {
  mimeType: typeof GENERATED_IMAGE_MIME_TYPE;
  width: number;
  height: number;
};

function hasAsciiAt(bytes: Uint8Array, offset: number, value: string) {
  if (offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index++) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function assertDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_AI_GENERATED_IMAGE_DIMENSION ||
    height > MAX_AI_GENERATED_IMAGE_DIMENSION ||
    width * height > MAX_AI_GENERATED_IMAGE_PIXELS
  ) {
    throw new InvalidGeneratedImageError(
      `Generated image dimensions are not allowed: ${width}x${height}`,
    );
  }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function pngChunkCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset++) {
    crc = CRC32_TABLE[(crc ^ bytes[offset]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type PngRowLayout = {
  byteLength: number;
  pixelCount: number;
  pass: number;
};

const ADAM7_PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

function pngRowLayouts(
  width: number,
  height: number,
  bitsPerPixel: number,
  interlace: number,
): PngRowLayout[] {
  if (interlace === 0) {
    const byteLength = Math.ceil((width * bitsPerPixel) / 8);
    return Array.from({ length: height }, () => ({
      byteLength,
      pixelCount: width,
      pass: 0,
    }));
  }

  const rows: PngRowLayout[] = [];
  for (const [pass, [startX, startY, stepX, stepY]] of
    ADAM7_PASSES.entries()) {
    const passWidth = width <= startX
      ? 0
      : Math.ceil((width - startX) / stepX);
    const passHeight = height <= startY
      ? 0
      : Math.ceil((height - startY) / stepY);
    if (passWidth === 0 || passHeight === 0) continue;
    const byteLength = Math.ceil((passWidth * bitsPerPixel) / 8);
    for (let row = 0; row < passHeight; row++) {
      rows.push({ byteLength, pixelCount: passWidth, pass });
    }
  }
  return rows;
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

function unfilterPngRow(
  filter: number,
  filtered: Uint8Array,
  previous: Uint8Array | null,
  bytesPerPixel: number,
): Uint8Array {
  const row = new Uint8Array(filtered.length);
  for (let index = 0; index < filtered.length; index++) {
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
    const above = previous?.[index] ?? 0;
    const upperLeft = index >= bytesPerPixel
      ? previous?.[index - bytesPerPixel] ?? 0
      : 0;
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
    row[index] = (filtered[index] + predictor) & 0xff;
  }
  return row;
}

function assertPaletteIndexes(
  row: Uint8Array,
  pixelCount: number,
  bitDepth: number,
  paletteEntries: number,
): void {
  const mask = (1 << bitDepth) - 1;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const bitOffset = pixel * bitDepth;
    const shift = 8 - bitDepth - (bitOffset % 8);
    const paletteIndex = (row[Math.floor(bitOffset / 8)] >> shift) & mask;
    if (paletteIndex >= paletteEntries) {
      throw new InvalidGeneratedImageError(
        "PNG contains a palette index outside PLTE",
      );
    }
  }
}

async function decodePngData(
  compressedParts: Uint8Array[],
  rowLayouts: PngRowLayout[],
  bitsPerPixel: number,
  bitDepth: number,
  paletteEntries: number | null,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const expectedBytes = rowLayouts.reduce(
    (sum, row) => sum + 1 + row.byteLength,
    0,
  );
  if (expectedBytes < 1 || expectedBytes > MAX_PNG_DECODED_BYTES) {
    throw new InvalidGeneratedImageError(
      "Generated PNG expands beyond the decode limit",
    );
  }

  const compressedBytes = compressedParts.reduce(
    (sum, part) => sum + part.byteLength,
    0,
  );
  const compressed = new Uint8Array(compressedBytes);
  let compressedOffset = 0;
  for (const part of compressedParts) {
    compressed.set(part, compressedOffset);
    compressedOffset += part.byteLength;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = new Blob([compressed.buffer])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"))
      .getReader();
  } catch (cause) {
    throw new InvalidGeneratedImageError(
      "Generated PNG could not be decoded",
      { cause },
    );
  }

  let total = 0;
  let rowIndex = 0;
  let filter: number | null = null;
  let filteredOffset = 0;
  let filteredRow = new Uint8Array(rowLayouts[0].byteLength);
  let previousRow: Uint8Array | null = null;
  let previousPass = -1;
  const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const abortSignal = signal;
  const cancelOnAbort = abortSignal === undefined
    ? undefined
    : () => {
        void reader.cancel(abortSignal.reason).catch(() => undefined);
      };
  if (abortSignal && cancelOnAbort) {
    abortSignal.addEventListener("abort", cancelOnAbort, { once: true });
  }
  try {
    signal?.throwIfAborted();
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      for (const byte of value) {
        if (total >= expectedBytes || rowIndex >= rowLayouts.length) {
          throw new InvalidGeneratedImageError(
            "Generated PNG contains excess decoded data",
          );
        }
        total++;
        if (filter === null) {
          if (byte > 4) {
            throw new InvalidGeneratedImageError(
              "Generated PNG contains an invalid scanline filter",
            );
          }
          filter = byte;
          continue;
        }

        filteredRow[filteredOffset++] = byte;
        const layout = rowLayouts[rowIndex];
        if (filteredOffset === layout.byteLength) {
          if (layout.pass !== previousPass) previousRow = null;
          const row = unfilterPngRow(
            filter,
            filteredRow,
            previousRow,
            bytesPerPixel,
          );
          if (paletteEntries !== null) {
            assertPaletteIndexes(
              row,
              layout.pixelCount,
              bitDepth,
              paletteEntries,
            );
          }
          previousRow = row;
          previousPass = layout.pass;
          rowIndex++;
          filter = null;
          filteredOffset = 0;
          if (rowIndex < rowLayouts.length) {
            filteredRow = new Uint8Array(rowLayouts[rowIndex].byteLength);
          }
        }
      }
    }
  } catch (cause) {
    await reader.cancel(cause).catch(() => undefined);
    signal?.throwIfAborted();
    if (cause instanceof InvalidGeneratedImageError) throw cause;
    throw new InvalidGeneratedImageError(
      "Generated PNG contains corrupt compressed data",
      { cause },
    );
  } finally {
    if (abortSignal && cancelOnAbort) {
      abortSignal.removeEventListener("abort", cancelOnAbort);
    }
  }

  signal?.throwIfAborted();
  if (
    total !== expectedBytes ||
    rowIndex !== rowLayouts.length ||
    filter !== null ||
    filteredOffset !== 0
  ) {
    throw new InvalidGeneratedImageError(
      "Generated PNG contains incomplete decoded data",
    );
  }
}

async function parsePng(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ImageMetadata> {
  signal?.throwIfAborted();
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length < 45 ||
    !signature.every((byte, index) => bytes[index] === byte)
  ) {
    throw new InvalidGeneratedImageError("Generated PNG signature is invalid");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = signature.length;
  let chunkIndex = 0;
  let width = 0;
  let height = 0;
  let bitsPerPixel = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawPlte = false;
  let paletteEntries = 0;
  let sawIdat = false;
  let idatEnded = false;
  const idatParts: Uint8Array[] = [];

  while (offset + 12 <= bytes.length) {
    signal?.throwIfAborted();
    const length = view.getUint32(offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataOffset || chunkEnd > bytes.length) {
      throw new InvalidGeneratedImageError("Generated PNG chunk is truncated");
    }
    const expectedCrc = view.getUint32(dataEnd);
    if (pngChunkCrc(bytes, typeOffset, dataEnd) !== expectedCrc) {
      throw new InvalidGeneratedImageError("Generated PNG chunk CRC is invalid");
    }

    const type = String.fromCharCode(...bytes.subarray(typeOffset, typeOffset + 4));
    if (
      !/^[A-Za-z]{4}$/u.test(type) ||
      (type.charCodeAt(2) >= 0x61 && type.charCodeAt(2) <= 0x7a)
    ) {
      throw new InvalidGeneratedImageError("Generated PNG chunk type is invalid");
    }
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) {
      throw new InvalidGeneratedImageError("Generated PNG has no valid IHDR");
    }
    if (type === "IHDR") {
      if (chunkIndex !== 0 || length !== 13) {
        throw new InvalidGeneratedImageError("Generated PNG has duplicate IHDR");
      }
      width = view.getUint32(dataOffset);
      height = view.getUint32(dataOffset + 4);
      bitDepth = bytes[dataOffset + 8];
      colorType = bytes[dataOffset + 9];
      const validDepths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      const channels: Record<number, number> = {
        0: 1,
        2: 3,
        3: 1,
        4: 2,
        6: 4,
      };
      if (
        !validDepths[colorType]?.includes(bitDepth) ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        (bytes[dataOffset + 12] !== 0 && bytes[dataOffset + 12] !== 1)
      ) {
        throw new InvalidGeneratedImageError("Generated PNG IHDR is invalid");
      }
      interlace = bytes[dataOffset + 12];
      bitsPerPixel = channels[colorType] * bitDepth;
      assertDimensions(width, height);
    } else if (type === "PLTE") {
      if (
        sawPlte ||
        sawIdat ||
        colorType === 0 ||
        colorType === 4 ||
        length < 3 ||
        length > 768 ||
        length % 3 !== 0 ||
        (colorType === 3 && length / 3 > 2 ** bitDepth)
      ) {
        throw new InvalidGeneratedImageError("Generated PNG PLTE is invalid");
      }
      sawPlte = true;
      paletteEntries = length / 3;
    } else if (type === "IDAT") {
      if (colorType === 3 && !sawPlte) {
        throw new InvalidGeneratedImageError("Generated indexed PNG has no palette");
      }
      if (idatEnded) {
        throw new InvalidGeneratedImageError("Generated PNG IDAT is invalid");
      }
      sawIdat = true;
      idatParts.push(bytes.subarray(dataOffset, dataEnd));
    } else {
      if (sawIdat) idatEnded = true;
      if (type === "IEND") {
        if (length !== 0 || !sawIdat || chunkEnd !== bytes.length) {
          throw new InvalidGeneratedImageError("Generated PNG IEND is invalid");
        }
        await decodePngData(
          idatParts,
          pngRowLayouts(width, height, bitsPerPixel, interlace),
          bitsPerPixel,
          bitDepth,
          colorType === 3 ? paletteEntries : null,
          signal,
        );
        signal?.throwIfAborted();
        return { mimeType: "image/png", width, height };
      }
      if (
        type.charCodeAt(0) >= 0x41 &&
        type.charCodeAt(0) <= 0x5a &&
        type !== "PLTE"
      ) {
        throw new InvalidGeneratedImageError(
          `Generated PNG has an unknown critical chunk: ${type}`,
        );
      }
    }

    offset = chunkEnd;
    chunkIndex++;
  }
  throw new InvalidGeneratedImageError("Generated PNG is incomplete");
}

export function decodeGeneratedImageBase64(value: string): ArrayBuffer {
  const maximumEncodedLength =
    Math.ceil(MAX_AI_GENERATED_IMAGE_BYTES / 3) * 4 + 2;
  if (
    value.length === 0 ||
    value.length > maximumEncodedLength ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value) ||
    /=/.test(value.slice(0, -2))
  ) {
    throw new InvalidGeneratedImageError("Generated image base64 is invalid");
  }

  let binary: string;
  try {
    binary = atob(value);
  } catch (cause) {
    throw new InvalidGeneratedImageError(
      "Generated image base64 is invalid",
      { cause },
    );
  }
  if (binary.length > MAX_AI_GENERATED_IMAGE_BYTES) {
    throw new InvalidGeneratedImageError("Generated image is too large");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

async function inspectPngBytes(
  value: ArrayBuffer,
  signal?: AbortSignal,
): Promise<ImageMetadata> {
  signal?.throwIfAborted();
  const bytes = new Uint8Array(value);
  if (bytes[0] !== 0x89 || !hasAsciiAt(bytes, 1, "PNG")) {
    throw new InvalidGeneratedImageError(
      "Image bytes are not PNG",
    );
  }
  return await parsePng(bytes, signal);
}

export async function inspectInputPng(
  value: ArrayBuffer,
  signal?: AbortSignal,
): Promise<ImageMetadata> {
  signal?.throwIfAborted();
  if (value.byteLength === 0 || value.byteLength > MAX_AI_GENERATED_IMAGE_BYTES) {
    throw new InvalidGeneratedImageError("Input PNG size is invalid");
  }
  return await inspectPngBytes(value, signal);
}

export async function inspectGeneratedImage(
  value: ArrayBuffer,
  declaredMimeType: string,
): Promise<ImageMetadata> {
  if (value.byteLength === 0 || value.byteLength > MAX_AI_GENERATED_IMAGE_BYTES) {
    throw new InvalidGeneratedImageError("Generated image size is invalid");
  }
  const declared = declaredMimeType.trim().toLowerCase();
  if (declared !== GENERATED_IMAGE_MIME_TYPE) {
    throw new InvalidGeneratedImageError(
      `Generated images must be declared as ${GENERATED_IMAGE_MIME_TYPE}`,
    );
  }

  const metadata = await inspectPngBytes(value);
  if (metadata.mimeType !== declared) {
    throw new InvalidGeneratedImageError(
      `Generated image MIME mismatch: declared ${declared}, actual ${metadata.mimeType}`,
    );
  }
  return metadata;
}
