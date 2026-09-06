import {
  inspectInputPng,
  MAX_AI_GENERATED_IMAGE_DIMENSION,
  MAX_AI_GENERATED_IMAGE_PIXELS,
} from "./image-validation";

export type AiInputImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

export type ValidatedAiInputImage = {
  bytes: ArrayBuffer;
  mimeType: AiInputImageMimeType;
};

const extensionMimeTypes: Record<string, AiInputImageMimeType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

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
    throw new Error("Input image dimensions are not allowed");
  }
}

function hasAsciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index++) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function inspectJpeg(bytes: Uint8Array): void {
  if (
    bytes.length < 16 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8
  ) {
    throw new Error("Invalid JPEG header");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  let entropyBytes = 0;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw new Error("Invalid JPEG marker");
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) throw new Error("Truncated JPEG marker");
    const marker = bytes[offset++];

    if (marker === 0xd9) {
      if (!sawFrame || !sawScan || entropyBytes === 0 || offset !== bytes.length) {
        throw new Error("Incomplete JPEG image");
      }
      return;
    }
    if (
      marker === 0x00 ||
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      throw new Error("Unexpected standalone JPEG marker");
    }
    if (offset + 2 > bytes.length) throw new Error("Truncated JPEG segment");

    const segmentLength = view.getUint16(offset);
    if (segmentLength < 2) throw new Error("Invalid JPEG segment length");
    const dataOffset = offset + 2;
    const segmentEnd = offset + segmentLength;
    if (segmentEnd > bytes.length) throw new Error("Truncated JPEG segment");

    if (startOfFrameMarkers.has(marker)) {
      if (sawFrame || segmentLength < 11) {
        throw new Error("Invalid JPEG frame header");
      }
      const precision = bytes[dataOffset];
      const height = view.getUint16(dataOffset + 1);
      const width = view.getUint16(dataOffset + 3);
      const components = bytes[dataOffset + 5];
      if (
        precision === 0 ||
        components === 0 ||
        segmentLength !== 8 + components * 3
      ) {
        throw new Error("Invalid JPEG frame header");
      }
      assertDimensions(width, height);
      sawFrame = true;
    }

    if (marker !== 0xda) {
      offset = segmentEnd;
      continue;
    }

    const scanComponents = bytes[dataOffset];
    if (
      !sawFrame ||
      scanComponents === 0 ||
      segmentLength !== 6 + scanComponents * 2
    ) {
      throw new Error("Invalid JPEG scan header");
    }
    sawScan = true;
    offset = segmentEnd;

    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        entropyBytes++;
        offset++;
        continue;
      }

      const markerOffset = offset;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) throw new Error("Truncated JPEG scan");
      const scanMarker = bytes[offset];
      if (scanMarker === 0x00) {
        entropyBytes++;
        offset++;
        continue;
      }
      if (scanMarker >= 0xd0 && scanMarker <= 0xd7) {
        offset++;
        continue;
      }
      offset = markerOffset;
      break;
    }
  }

  throw new Error("JPEG has no end marker");
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function inspectLossyWebpFrame(
  bytes: Uint8Array,
  dataOffset: number,
  length: number,
): { width: number; height: number } {
  if (length < 10 || bytes[dataOffset] % 2 !== 0) {
    throw new Error("Invalid lossy WebP frame");
  }
  const frameTag =
    bytes[dataOffset] |
    (bytes[dataOffset + 1] << 8) |
    (bytes[dataOffset + 2] << 16);
  const firstPartitionLength = frameTag >>> 5;
  if (firstPartitionLength < 1 || 10 + firstPartitionLength > length) {
    throw new Error("Truncated lossy WebP partition");
  }
  if (
    bytes[dataOffset + 3] !== 0x9d ||
    bytes[dataOffset + 4] !== 0x01 ||
    bytes[dataOffset + 5] !== 0x2a
  ) {
    throw new Error("Invalid lossy WebP frame signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(dataOffset + 6, true) & 0x3fff;
  const height = view.getUint16(dataOffset + 8, true) & 0x3fff;
  assertDimensions(width, height);
  return { width, height };
}

function inspectLosslessWebpFrame(
  bytes: Uint8Array,
  dataOffset: number,
  length: number,
): { width: number; height: number } {
  if (length <= 5 || bytes[dataOffset] !== 0x2f) {
    throw new Error("Invalid lossless WebP frame");
  }
  const width =
    1 + bytes[dataOffset + 1] + ((bytes[dataOffset + 2] & 0x3f) << 8);
  const height =
    1 +
    ((bytes[dataOffset + 2] & 0xc0) >> 6) +
    (bytes[dataOffset + 3] << 2) +
    ((bytes[dataOffset + 4] & 0x0f) << 10);
  if ((bytes[dataOffset + 4] & 0xe0) !== 0) {
    throw new Error("Unsupported lossless WebP version");
  }
  assertDimensions(width, height);
  return { width, height };
}

function inspectAnimatedWebpFrame(
  bytes: Uint8Array,
  dataOffset: number,
  dataEnd: number,
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = dataOffset + 16;
  let sawImage = false;
  while (offset < dataEnd) {
    if (offset + 8 > dataEnd) throw new Error("Truncated animated WebP chunk");
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const length = view.getUint32(offset + 4, true);
    const nestedDataOffset = offset + 8;
    const nestedDataEnd = nestedDataOffset + length;
    const nestedChunkEnd = nestedDataEnd + (length % 2);
    if (nestedDataEnd < nestedDataOffset || nestedChunkEnd > dataEnd) {
      throw new Error("Truncated animated WebP chunk");
    }
    if (type === "VP8 ") {
      if (sawImage) throw new Error("Animated WebP frame has duplicate images");
      inspectLossyWebpFrame(bytes, nestedDataOffset, length);
      sawImage = true;
    } else if (type === "VP8L") {
      if (sawImage) throw new Error("Animated WebP frame has duplicate images");
      inspectLosslessWebpFrame(bytes, nestedDataOffset, length);
      sawImage = true;
    } else if (type !== "ALPH") {
      throw new Error("Animated WebP frame has an unsupported sub-chunk");
    }
    offset = nestedChunkEnd;
  }
  if (!sawImage || offset !== dataEnd) {
    throw new Error("Animated WebP frame has no image payload");
  }
}

function inspectWebp(bytes: Uint8Array): void {
  if (
    bytes.length < 30 ||
    !hasAsciiAt(bytes, 0, "RIFF") ||
    !hasAsciiAt(bytes, 8, "WEBP")
  ) {
    throw new Error("Invalid WebP header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) {
    throw new Error("Invalid WebP RIFF length");
  }

  let offset = 12;
  let chunkIndex = 0;
  let sawExtendedHeader = false;
  let sawImagePayload = false;
  let sawAnimatedPayload = false;
  let canvasWidth: number | null = null;
  let canvasHeight: number | null = null;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error("Truncated WebP chunk");
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const length = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    const chunkEnd = dataEnd + (length % 2);
    if (dataEnd < dataOffset || chunkEnd > bytes.length) {
      throw new Error("Truncated WebP chunk");
    }

    if (type === "VP8X") {
      if (chunkIndex !== 0 || sawExtendedHeader || length !== 10) {
        throw new Error("Invalid WebP extended header");
      }
      const flags = bytes[dataOffset];
      if ((flags & 0xc1) !== 0) throw new Error("Invalid WebP feature flags");
      canvasWidth = readUint24LittleEndian(bytes, dataOffset + 4) + 1;
      canvasHeight = readUint24LittleEndian(bytes, dataOffset + 7) + 1;
      assertDimensions(canvasWidth, canvasHeight);
      sawExtendedHeader = true;
    } else if (type === "VP8 ") {
      if (sawImagePayload || sawAnimatedPayload) {
        throw new Error("WebP has duplicate image payloads");
      }
      inspectLossyWebpFrame(bytes, dataOffset, length);
      if (!sawExtendedHeader && chunkIndex !== 0) {
        throw new Error("Invalid simple WebP chunk order");
      }
      sawImagePayload = true;
    } else if (type === "VP8L") {
      if (sawImagePayload || sawAnimatedPayload) {
        throw new Error("WebP has duplicate image payloads");
      }
      inspectLosslessWebpFrame(bytes, dataOffset, length);
      if (!sawExtendedHeader && chunkIndex !== 0) {
        throw new Error("Invalid simple WebP chunk order");
      }
      sawImagePayload = true;
    } else if (type === "ANMF") {
      if (!sawExtendedHeader || sawImagePayload || length <= 24) {
        throw new Error("Invalid animated WebP frame");
      }
      const width = readUint24LittleEndian(bytes, dataOffset + 6) + 1;
      const height = readUint24LittleEndian(bytes, dataOffset + 9) + 1;
      assertDimensions(width, height);
      inspectAnimatedWebpFrame(bytes, dataOffset, dataEnd);
      sawAnimatedPayload = true;
    }

    offset = chunkEnd;
    chunkIndex++;
  }

  if (
    offset !== bytes.length ||
    (!sawImagePayload && !sawAnimatedPayload) ||
    (!sawExtendedHeader && chunkIndex !== 1) ||
    (sawExtendedHeader && (canvasWidth === null || canvasHeight === null))
  ) {
    throw new Error("WebP has no complete image payload");
  }
}

function skipGifSubBlocks(
  bytes: Uint8Array,
  start: number,
): { offset: number; hasData: boolean } {
  let offset = start;
  let hasData = false;
  for (;;) {
    if (offset >= bytes.length) throw new Error("Truncated GIF sub-block");
    const length = bytes[offset++];
    if (length === 0) return { offset, hasData };
    hasData = true;
    if (offset + length > bytes.length) throw new Error("Truncated GIF sub-block");
    offset += length;
  }
}

function inspectGif(bytes: Uint8Array): void {
  if (
    bytes.length < 20 ||
    (!hasAsciiAt(bytes, 0, "GIF87a") && !hasAsciiAt(bytes, 0, "GIF89a"))
  ) {
    throw new Error("Invalid GIF header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const screenWidth = view.getUint16(6, true);
  const screenHeight = view.getUint16(8, true);
  assertDimensions(screenWidth, screenHeight);

  const logicalScreenFlags = bytes[10];
  let offset = 13;
  if ((logicalScreenFlags & 0x80) !== 0) {
    offset += 3 * 2 ** ((logicalScreenFlags & 0x07) + 1);
    if (offset > bytes.length) throw new Error("Truncated GIF color table");
  }

  let sawImage = false;
  while (offset < bytes.length) {
    const introducer = bytes[offset++];
    if (introducer === 0x3b) {
      if (!sawImage || offset !== bytes.length) {
        throw new Error("Incomplete GIF image");
      }
      return;
    }
    if (introducer === 0x21) {
      if (offset >= bytes.length) throw new Error("Truncated GIF extension");
      offset++;
      offset = skipGifSubBlocks(bytes, offset).offset;
      continue;
    }
    if (introducer !== 0x2c || offset + 9 > bytes.length) {
      throw new Error("Invalid GIF block");
    }

    const width = view.getUint16(offset + 4, true);
    const height = view.getUint16(offset + 6, true);
    assertDimensions(width, height);
    const imageFlags = bytes[offset + 8];
    offset += 9;
    if ((imageFlags & 0x80) !== 0) {
      offset += 3 * 2 ** ((imageFlags & 0x07) + 1);
      if (offset > bytes.length) throw new Error("Truncated GIF color table");
    }
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) {
      throw new Error("Invalid GIF LZW code size");
    }
    offset++;
    const imageData = skipGifSubBlocks(bytes, offset);
    if (!imageData.hasData) throw new Error("GIF frame has no image data");
    offset = imageData.offset;
    sawImage = true;
  }

  throw new Error("GIF has no trailer");
}

function sniffMimeType(bytes: Uint8Array): AiInputImageMimeType | null {
  if (bytes[0] === 0x89 && hasAsciiAt(bytes, 1, "PNG")) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (hasAsciiAt(bytes, 0, "RIFF") && hasAsciiAt(bytes, 8, "WEBP")) {
    return "image/webp";
  }
  if (hasAsciiAt(bytes, 0, "GIF87a") || hasAsciiAt(bytes, 0, "GIF89a")) {
    return "image/gif";
  }
  return null;
}

function normalizeClaimedMimeType(value: string): string {
  const mimeType = value.toLowerCase().split(";", 1)[0].trim();
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

function filenameExtension(filename: string): string | null {
  const separator = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  const dot = filename.lastIndexOf(".");
  return dot > separator + 1 && dot < filename.length - 1
    ? filename.slice(dot + 1).toLowerCase()
    : null;
}

export async function validateAiInputImage(
  file: File,
  allowedMimeTypes: ReadonlySet<AiInputImageMimeType>,
): Promise<ValidatedAiInputImage | null> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return null;
  }

  const data = new Uint8Array(bytes);
  const mimeType = sniffMimeType(data);
  if (!mimeType || !allowedMimeTypes.has(mimeType)) return null;

  const claimedMimeType = normalizeClaimedMimeType(file.type);
  if (claimedMimeType && claimedMimeType !== mimeType) return null;
  const extension = filenameExtension(file.name);
  if (extension && extensionMimeTypes[extension] !== mimeType) return null;

  try {
    switch (mimeType) {
      case "image/png":
        await inspectInputPng(bytes);
        break;
      case "image/jpeg":
        inspectJpeg(data);
        break;
      case "image/webp":
        inspectWebp(data);
        break;
      case "image/gif":
        inspectGif(data);
        break;
    }
  } catch {
    return null;
  }

  return { bytes, mimeType };
}
