import { describe, expect, it } from "vitest";
import {
  inspectGeneratedVideo,
  InvalidGeneratedVideoError,
} from "../../packages/api/src/ai/video-validation";

function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function isoBox(type: string, ...payload: Uint8Array[]): Uint8Array {
  const data = join(...payload);
  const result = new Uint8Array(8 + data.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, result.byteLength);
  result.set(text(type), 4);
  result.set(data, 8);
  return result;
}

export function validMp4Bytes(): Uint8Array {
  const fileType = isoBox(
    "ftyp",
    text("isom"),
    Uint8Array.from([0, 0, 0, 1]),
    text("mp42"),
  );
  const handler = new Uint8Array(12);
  handler.set(text("vide"), 8);
  const media = isoBox(
    "mdia",
    isoBox("mdhd", Uint8Array.from([0])),
    isoBox("hdlr", handler),
    isoBox("minf"),
  );
  const movie = isoBox(
    "moov",
    isoBox("mvhd", Uint8Array.from([0])),
    isoBox("trak", isoBox("tkhd", Uint8Array.from([0])), media),
  );
  return join(fileType, movie, isoBox("mdat", Uint8Array.from([1, 2, 3])));
}

function ebmlSize(value: number): Uint8Array {
  if (value < 0 || value > 0x7e) {
    throw new RangeError("Test EBML element is too large");
  }
  return Uint8Array.from([0x80 | value]);
}

function ebmlElement(id: number[], ...payload: Uint8Array[]): Uint8Array {
  const data = join(...payload);
  return join(Uint8Array.from(id), ebmlSize(data.byteLength), data);
}

export function validWebmBytes(): Uint8Array {
  const header = ebmlElement(
    [0x1a, 0x45, 0xdf, 0xa3],
    ebmlElement([0x42, 0x82], text("webm")),
  );
  const info = ebmlElement(
    [0x15, 0x49, 0xa9, 0x66],
    ebmlElement([0x2a, 0xd7, 0xb1], Uint8Array.from([0x0f, 0x42, 0x40])),
  );
  const trackEntry = ebmlElement(
    [0xae],
    ebmlElement([0xd7], Uint8Array.from([1])),
    ebmlElement([0x83], Uint8Array.from([1])),
    ebmlElement([0x86], text("V_VP9")),
    ebmlElement([0xe0]),
  );
  const tracks = ebmlElement([0x16, 0x54, 0xae, 0x6b], trackEntry);
  const cluster = ebmlElement(
    [0x1f, 0x43, 0xb6, 0x75],
    ebmlElement([0xe7], Uint8Array.from([0])),
    ebmlElement(
      [0xa3],
      Uint8Array.from([0x81, 0, 0, 0, 0x01]),
    ),
  );
  return join(
    header,
    ebmlElement([0x18, 0x53, 0x80, 0x67], info, tracks, cluster),
  );
}

describe("generated video container validation", () => {
  it("accepts a bounded, structurally complete MP4 video track", () => {
    expect(
      inspectGeneratedVideo(validMp4Bytes().buffer, "video/mp4"),
    ).toEqual({ mimeType: "video/mp4", extension: "mp4" });
  });

  it("accepts a structurally complete WebM video track", () => {
    expect(
      inspectGeneratedVideo(validWebmBytes().buffer, "video/webm"),
    ).toEqual({ mimeType: "video/webm", extension: "webm" });
  });

  it("rejects an MP4 signature without movie and media structure", () => {
    const headerOnly = isoBox(
      "ftyp",
      text("isom"),
      Uint8Array.from([0, 0, 0, 1]),
      text("mp42"),
    );

    expect(() => inspectGeneratedVideo(headerOnly.buffer, "video/mp4"))
      .toThrow(InvalidGeneratedVideoError);
  });

  it("rejects truncated MP4 boxes", () => {
    const truncated = validMp4Bytes().slice(0, -1);

    expect(() => inspectGeneratedVideo(truncated.buffer, "video/mp4"))
      .toThrow(InvalidGeneratedVideoError);
  });

  it("rejects WebM metadata without a media cluster", () => {
    const complete = validWebmBytes();
    const clusterOffset = complete.findIndex(
      (byte, index) =>
        byte === 0x1f &&
        complete[index + 1] === 0x43 &&
        complete[index + 2] === 0xb6 &&
        complete[index + 3] === 0x75,
    );
    const truncated = complete.slice(0, clusterOffset);

    expect(() => inspectGeneratedVideo(truncated.buffer, "video/webm"))
      .toThrow(InvalidGeneratedVideoError);
  });

  it("rejects a declared container that disagrees with sniffed bytes", () => {
    expect(() =>
      inspectGeneratedVideo(validWebmBytes().buffer, "video/mp4"),
    ).toThrow(InvalidGeneratedVideoError);
  });
});
