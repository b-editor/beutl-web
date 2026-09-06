import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import {
  decodeGeneratedImageBase64,
  inspectGeneratedImage,
  InvalidGeneratedImageError,
} from "../../packages/api/src/ai/image-validation";

const VALID_PNG = {
  mimeType: "image/png",
  width: 1,
  height: 1,
  base64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
} as const;

const VALID_INDEXED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAADAFBMVEX/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAXiZlVAAAACklEQVR42mNgAAAAAgAB5Sfe/AAAAABJRU5ErkJggg==";

const VALID_NON_PNG_IMAGES = [
  {
    mimeType: "image/jpeg",
    base64:
      "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z",
  },
  {
    mimeType: "image/webp",
    base64:
      "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAMAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=",
  },
] as const;

const INVALID_NON_PNG_PAYLOADS = [
  {
    name: "JPEG with arbitrary entropy after a plausible SOF/SOS",
    mimeType: "image/jpeg",
    bytes: Uint8Array.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01,
      0xff, 0xda, 0x00, 0x02, 0x01,
      0xff, 0xd9,
    ]),
  },
  {
    name: "WebP with a plausible VP8 keyframe header but no bitstream",
    mimeType: "image/webp",
    bytes: Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x20, 0x0a, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00,
    ]),
  },
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

function indexedPng(sampleByte = 0): ArrayBuffer {
  const chunk = (type: string, data: Uint8Array) => {
    const result = new Uint8Array(12 + data.length);
    const view = new DataView(result.buffer);
    view.setUint32(0, data.length);
    result.set(new TextEncoder().encode(type), 4);
    result.set(data, 8);
    view.setUint32(8 + data.length, crc32(result.subarray(4, 8 + data.length)));
    return result;
  };
  const signature = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, 1);
  headerView.setUint32(4, 1);
  header[8] = 1;
  header[9] = 3;
  const parts = [
    signature,
    chunk("IHDR", header),
    chunk("PLTE", Uint8Array.from([0xff, 0, 0])),
    chunk(
      "IDAT",
      Uint8Array.from(deflateSync(Uint8Array.from([0, sampleByte]))),
    ),
    chunk("IEND", new Uint8Array()),
  ];
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result.buffer;
}

function corruptPngDeflateWithValidCrc(): ArrayBuffer {
  const bytes = new Uint8Array(decodeGeneratedImageBase64(VALID_PNG.base64));
  const view = new DataView(bytes.buffer);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    if (String.fromCharCode(...bytes.subarray(typeOffset, dataOffset)) === "IDAT") {
      bytes[dataOffset + Math.floor(length / 2)] ^= 0xff;
      view.setUint32(dataEnd, crc32(bytes.subarray(typeOffset, dataEnd)));
      return bytes.buffer;
    }
    offset = dataEnd + 4;
  }
  throw new Error("PNG fixture has no IDAT chunk");
}

describe("generated image byte validation", () => {
  it("fully decodes a valid PNG through every scanline", async () => {
    const bytes = decodeGeneratedImageBase64(VALID_PNG.base64);

    await expect(inspectGeneratedImage(bytes, VALID_PNG.mimeType)).resolves.toEqual({
      mimeType: VALID_PNG.mimeType,
      width: VALID_PNG.width,
      height: VALID_PNG.height,
    });
  });

  it("accepts a fully validated indexed PNG from the provider", async () => {
    await expect(
      inspectGeneratedImage(indexedPng(), "image/png"),
    ).resolves.toEqual({
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
  });

  it("rejects an indexed PNG whose packed sample exceeds the palette", async () => {
    await expect(
      inspectGeneratedImage(indexedPng(0x80), "image/png"),
    ).rejects.toBeInstanceOf(InvalidGeneratedImageError);
  });

  it("rejects a truncated indexed PNG", async () => {
    await expect(
      inspectGeneratedImage(
        decodeGeneratedImageBase64(VALID_INDEXED_PNG_BASE64),
        "image/png",
      ),
    ).rejects.toBeInstanceOf(InvalidGeneratedImageError);
  });

  it("rejects valid bytes when the declared MIME differs", async () => {
    const bytes = decodeGeneratedImageBase64(VALID_PNG.base64);

    await expect(
      inspectGeneratedImage(bytes, "image/jpeg"),
    ).rejects.toBeInstanceOf(InvalidGeneratedImageError);
  });

  it("rejects a parameterized MIME instead of weakening exact matching", async () => {
    const bytes = decodeGeneratedImageBase64(VALID_PNG.base64);

    await expect(
      inspectGeneratedImage(bytes, "image/png; charset=binary"),
    ).rejects.toBeInstanceOf(InvalidGeneratedImageError);
  });

  it("rejects a truncated PNG", async () => {
    const complete = new Uint8Array(
      decodeGeneratedImageBase64(VALID_PNG.base64),
    );
    const truncated = complete.slice(0, -1).buffer;

    await expect(
      inspectGeneratedImage(truncated, VALID_PNG.mimeType),
    ).rejects.toBeInstanceOf(InvalidGeneratedImageError);
  });

  it("rejects corrupt PNG deflate data even when the chunk CRC is valid", async () => {
    await expect(
      inspectGeneratedImage(
        corruptPngDeflateWithValidCrc(),
        VALID_PNG.mimeType,
      ),
    ).rejects.toBeInstanceOf(InvalidGeneratedImageError);
  });

  it.each(VALID_NON_PNG_IMAGES)(
    "rejects even a decodable $mimeType result because generated outputs are PNG-only",
    async ({ base64, mimeType }) => {
      const bytes = decodeGeneratedImageBase64(base64);

      await expect(
        inspectGeneratedImage(bytes, mimeType),
      ).rejects.toBeInstanceOf(InvalidGeneratedImageError);
    },
  );

  it.each(INVALID_NON_PNG_PAYLOADS)(
    "rejects $name before it can be stored",
    async ({ bytes, mimeType }) => {
      await expect(
        inspectGeneratedImage(bytes.slice().buffer, mimeType),
      ).rejects.toBeInstanceOf(InvalidGeneratedImageError);
    },
  );
});
