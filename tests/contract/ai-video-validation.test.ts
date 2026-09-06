import { describe, expect, it } from "vitest";
import {
  inspectGeneratedVideo,
  InvalidGeneratedVideoError,
  MAX_AI_VIDEO_PARSE_ITEMS,
} from "../../packages/api/src/ai/video-validation";

const VALID_MP4_BASE64 =
  "AAAAIGZ0eXBtcDQyAAAAAG1wNDJtcDQxaXNvbWlzbzIAAAAIZnJlZQAAAwZtZGF0AAAAAgkQAAAAGGf0EA2Q2XewFqDAwMgAAAMACAAAAwAUIAAAAAVo7jESEQAAArQGBf//sNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0xIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMiBtaXhlZF9yZWY9MCBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9NCB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MSBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0wIHJjPWNiciBtYnRyZWU9MCBiaXRyYXRlPTIwNDggcmF0ZXRvbD0xLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTgxIHFwc3RlcD00IHZidl9tYXhyYXRlPTIwNDggdmJ2X2J1ZnNpemU9MjA0OCBuYWxfaHJkPW5vbmUgZmlsbGVyPTAgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAABdliIQCb/73wP8Cm+9ImZ+BOrS/AnWCgQAAA3Btb292AAAAbG12aGQAAAAA5qLnNuai5zYAAAyAAAAMgAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACv3RyYWsAAABcdGtoZAAAAAfmouc25qLnNgAAAAEAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAEAAAABAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAADIAAAAAAAAEAAAAAAd5tZGlhAAAAIG1kaGQAAAAA5qLnNuai5zYAAABkAAAAZFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAGJbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABSXN0YmwAAADNc3RzZAAAAAAAAAABAAAAvWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAEAAQAEgAAABIAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY//8AAAAwYXZjQwH0EA3/4QAYZ/QQDZDZd7AWoMDAyAAAAwAIAAADABQgAQAFaO4xEhEAAAAUYnRydAAAAAAAIAAAAAAX8AAAABNjb2xybmNseAAGAAYABgAAAAAQcGFzcAAAAAEAAAABAAAAGHN0dHMAAAAAAAAAAQAAAAEAAABkAAAAFHN0c3MAAAAAAAAAAQAAAAEAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAGHN0c3oAAAAAAAAAAAAAAAEAAAL+AAAAFHN0Y28AAAAAAAAAAQAAADAAAABZdWR0YQAAAFFtZXRhAAAAAAAAACFoZGxyAAAAAG1obHJtZGlyAAAAAAAAAAAAAAAAAAAAACRpbHN0AAAAHKl0b28AAAAUZGF0YQAAAAEAAAAAeDI2NAAAAD11ZHRhAAAANW1ldGEAAAAAAAAAIWhkbHIAAAAAbWhscm1kaXIAAAAAAAAAAAAAAAAAAAAACGlsc3Q=";

const VALID_WEBM_BASE64 =
  "GkXfowEAAAAAAAAQQoKFd2VibQBCh4ECQoWBAhhTgGcBAAAAAAABzBFNm3QBAAAAAAAAjE27AQAAAAAAABJTq4QVSalmU6yIAAAAAAAAAJhNuwEAAAAAAAASU6uEFlSua1OsiAAAAAAAAAEF7JoBAAAAAAAAElOrhBBDp3BTrIj//////////027AQAAAAAAABJTq4QcU7trU6yIAAAAAAAAAaTsmgEAAAAAAAASU6uEElTDZ1OsiP//////////FUmpZgEAAAAAAABhKtexgw9CQESJiECPQAAAAAAATYClR1N0cmVhbWVyIG1hdHJvc2thbXV4IHZlcnNpb24gMS4yNC4yAFdBmUdTdHJlYW1lciBNYXRyb3NrYSBtdXhlcgBEYYgLN5mX8f9P8BZUrmsBAAAAAAAAX64BAAAAAAAAVteBAYOBAXPFiLyT4Ui+l+tYI+ODhDuaygBTboZWaWRlbwDgAQAAAAAAACOwgRC6gRCagQJVsAEAAAAAAAAQVbmBAVWxgQZVuoEGVbuBBoaGVl9WUDgAH0O2dQEAAAAAAAAo54EAo6OBAACAEAIAnQEqEAAQAABHCIWFiJmEiAICAAwNYAD+/6tQgBxTu2sBAAAAAAAAHLsBAAAAAAAAE7OBALcBAAAAAAAAB/eBAfGCAXA=";

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

function uint32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value);
  return result;
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
  return Uint8Array.from(Buffer.from(VALID_MP4_BASE64, "base64"));
}

function metadataOnlyMp4Bytes(): Uint8Array {
  const fileType = isoBox(
    "ftyp",
    text("isom"),
    uint32(1),
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
  return join(
    fileType,
    isoBox(
      "moov",
      isoBox("mvhd", Uint8Array.from([0])),
      isoBox("trak", isoBox("tkhd", Uint8Array.from([0])), media),
    ),
    isoBox("mdat", Uint8Array.from([1, 2, 3])),
  );
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

function float64(value: number): Uint8Array {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setFloat64(0, value);
  return result;
}

function vp8Keyframe(): Uint8Array {
  return Uint8Array.from([
    0x10, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0, 0xaa,
  ]);
}

function vp9Keyframe(): Uint8Array {
  return Uint8Array.from([
    0x82,
    0x49,
    0x83,
    0x42,
    0x20,
    0,
    0,
    0,
    0,
  ]);
}

function av1Keyframe(): Uint8Array {
  return Uint8Array.from([
    0x0a,
    0x02,
    0x18,
    0,
    0x32,
    0x01,
    0x80,
  ]);
}

function webmWithSample({
  sample = vp8Keyframe(),
  extraSegmentElements = [],
  codec = "V_VP8",
  duration = 1,
  clusterTimestamp = 0,
}: {
  sample?: Uint8Array;
  extraSegmentElements?: Uint8Array[];
  codec?: string;
  duration?: number;
  clusterTimestamp?: number;
} = {}): Uint8Array {
  const header = ebmlElement(
    [0x1a, 0x45, 0xdf, 0xa3],
    ebmlElement([0x42, 0x82], text("webm")),
  );
  const info = ebmlElement(
    [0x15, 0x49, 0xa9, 0x66],
    ebmlElement(
      [0x2a, 0xd7, 0xb1],
      Uint8Array.from([0x3b, 0x9a, 0xca, 0]),
    ),
    ebmlElement([0x44, 0x89], float64(duration)),
  );
  const trackEntry = ebmlElement(
    [0xae],
    ebmlElement([0xd7], Uint8Array.from([1])),
    ebmlElement([0x73, 0xc5], Uint8Array.from([1])),
    ebmlElement([0x83], Uint8Array.from([1])),
    ebmlElement([0x86], text(codec)),
    ebmlElement(
      [0xe0],
      ebmlElement([0xb0], Uint8Array.from([1])),
      ebmlElement([0xba], Uint8Array.from([1])),
    ),
  );
  const tracks = ebmlElement([0x16, 0x54, 0xae, 0x6b], trackEntry);
  const cluster = ebmlElement(
    [0x1f, 0x43, 0xb6, 0x75],
    ebmlElement([0xe7], Uint8Array.from([clusterTimestamp])),
    ebmlElement(
      [0xa3],
      Uint8Array.from([0x81, 0, 0, 0x80]),
      sample,
    ),
  );
  const segmentData = join(info, tracks, ...extraSegmentElements, cluster);
  const segment = segmentData.byteLength <= 0x7e
    ? ebmlElement([0x18, 0x53, 0x80, 0x67], segmentData)
    : join(
      Uint8Array.from([0x18, 0x53, 0x80, 0x67, 0xff]),
      segmentData,
    );
  return join(header, segment);
}

export function validWebmBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(VALID_WEBM_BASE64, "base64"));
}

describe("generated video container validation", () => {
  it("accepts an MP4 video track with codec configuration and a referenced sample", () => {
    expect(inspectGeneratedVideo(validMp4Bytes().buffer, "video/mp4"))
      .toEqual({ mimeType: "video/mp4", extension: "mp4" });
  });

  it("accepts a WebM video track with a valid VP8 keyframe in a cluster", () => {
    expect(inspectGeneratedVideo(validWebmBytes().buffer, "video/webm"))
      .toEqual({ mimeType: "video/webm", extension: "webm" });
  });

  it("rejects a WebM document type with an embedded NUL", () => {
    const bytes = validWebmBytes();
    const documentType = bytes.findIndex(
      (byte, index) => byte === 0x77 &&
        bytes[index + 1] === 0x65 &&
        bytes[index + 2] === 0x62 &&
        bytes[index + 3] === 0x6d,
    );
    bytes[documentType + 2] = 0;

    expect(() => inspectGeneratedVideo(bytes.buffer, "video/webm"))
      .toThrow(InvalidGeneratedVideoError);
  });

  it("rejects MP4 metadata and media bytes without a decodable sample table", () => {
    expect(() =>
      inspectGeneratedVideo(metadataOnlyMp4Bytes().buffer, "video/mp4")
    ).toThrow(InvalidGeneratedVideoError);
  });

  it("rejects an MP4 whose sample table points outside media data", () => {
    const bytes = validMp4Bytes();
    const chunkOffset = bytes.findIndex(
      (byte, index) => byte === 0x73 &&
        bytes[index + 1] === 0x74 &&
        bytes[index + 2] === 0x63 &&
        bytes[index + 3] === 0x6f,
    );
    new DataView(bytes.buffer).setUint32(chunkOffset + 12, bytes.byteLength);

    expect(() => inspectGeneratedVideo(bytes.buffer, "video/mp4"))
      .toThrow(InvalidGeneratedVideoError);
  });

  it("rejects an MP4 with an empty-looking referenced sample", () => {
    const bytes = validMp4Bytes();
    const mediaDataType = bytes.findIndex(
      (byte, index) => byte === 0x6d &&
        bytes[index + 1] === 0x64 &&
        bytes[index + 2] === 0x61 &&
        bytes[index + 3] === 0x74,
    );
    const mediaDataStart = mediaDataType + 4;
    const mediaDataEnd = mediaDataType - 4 +
      new DataView(bytes.buffer).getUint32(mediaDataType - 4);
    bytes.fill(0, mediaDataStart, mediaDataEnd);

    expect(() => inspectGeneratedVideo(bytes.buffer, "video/mp4"))
      .toThrow(InvalidGeneratedVideoError);
  });

  it("rejects truncated MP4 boxes", () => {
    const truncated = validMp4Bytes().slice(0, -1);

    expect(() => inspectGeneratedVideo(truncated.buffer, "video/mp4"))
      .toThrow(InvalidGeneratedVideoError);
  });

  it("bounds MP4 parsing work for files made of tiny boxes", () => {
    const fileType = isoBox(
      "ftyp",
      text("isom"),
      uint32(1),
      text("mp42"),
    );
    const tinyBoxes = Array.from(
      { length: MAX_AI_VIDEO_PARSE_ITEMS },
      () => isoBox("free"),
    );

    expect(() =>
      inspectGeneratedVideo(join(fileType, ...tinyBoxes).buffer, "video/mp4")
    ).toThrow("parsing work limit");
  });

  it("rejects a WebM cluster containing only a fake block payload", () => {
    expect(() =>
      inspectGeneratedVideo(
        webmWithSample({ sample: Uint8Array.from([1, 2, 3, 4]) }).buffer,
        "video/webm",
      )
    ).toThrow(InvalidGeneratedVideoError);
  });

  it("rejects an MP4 whose referenced AVC sample is random non-zero data", () => {
    const bytes = validMp4Bytes();
    const mediaDataType = bytes.findIndex(
      (byte, index) => byte === 0x6d &&
        bytes[index + 1] === 0x64 &&
        bytes[index + 2] === 0x61 &&
        bytes[index + 3] === 0x74,
    );
    const mediaDataStart = mediaDataType + 4;
    const mediaDataEnd = mediaDataType - 4 +
      new DataView(bytes.buffer).getUint32(mediaDataType - 4);
    for (let offset = mediaDataStart; offset < mediaDataEnd; offset++) {
      bytes[offset] = (offset * 29 + 17) & 0xff;
    }

    expect(() => inspectGeneratedVideo(bytes.buffer, "video/mp4"))
      .toThrow(InvalidGeneratedVideoError);
  });

  it("rejects a one-byte AVC IDR NAL sample", () => {
    const bytes = validMp4Bytes();
    const mediaDataType = bytes.findIndex(
      (byte, index) => byte === 0x6d &&
        bytes[index + 1] === 0x64 &&
        bytes[index + 2] === 0x61 &&
        bytes[index + 3] === 0x74,
    );
    const mediaDataStart = mediaDataType + 4;
    const mediaDataEnd = mediaDataType - 4 +
      new DataView(bytes.buffer).getUint32(mediaDataType - 4);
    bytes.fill(0, mediaDataStart, mediaDataEnd);
    bytes.set([0, 0, 0, 1, 0x65], mediaDataStart);

    expect(() => inspectGeneratedVideo(bytes.buffer, "video/mp4"))
      .toThrow(InvalidGeneratedVideoError);
  });

  it("rejects an MP4 whose movie duration exceeds the generated-video limit", () => {
    const bytes = validMp4Bytes();
    const movieHeader = bytes.findIndex(
      (byte, index) => byte === 0x6d &&
        bytes[index + 1] === 0x76 &&
        bytes[index + 2] === 0x68 &&
        bytes[index + 3] === 0x64,
    );
    const view = new DataView(bytes.buffer);
    const timescale = view.getUint32(movieHeader + 16);
    view.setUint32(movieHeader + 20, timescale * 61);

    expect(() => inspectGeneratedVideo(bytes.buffer, "video/mp4"))
      .toThrow(InvalidGeneratedVideoError);
  });

  it("rejects inconsistent MP4 media and sample-table timing", () => {
    const bytes = validMp4Bytes();
    const sampleTiming = bytes.findIndex(
      (byte, index) => byte === 0x73 &&
        bytes[index + 1] === 0x74 &&
        bytes[index + 2] === 0x74 &&
        bytes[index + 3] === 0x73,
    );
    new DataView(bytes.buffer).setUint32(sampleTiming + 16, 1);

    expect(() => inspectGeneratedVideo(bytes.buffer, "video/mp4"))
      .toThrow(InvalidGeneratedVideoError);
  });

  it.each(["V_VP9", "V_AV1"])(
    "rejects a random %s keyframe payload",
    (codec) => {
      expect(() =>
        inspectGeneratedVideo(
          webmWithSample({
            codec,
            sample: Uint8Array.from([1, 2, 3, 4]),
          }).buffer,
          "video/webm",
        )
      ).toThrow(InvalidGeneratedVideoError);
    },
  );

  it("accepts a WebM VP9 keyframe with a sync header and matching dimensions", () => {
    expect(
      inspectGeneratedVideo(
        webmWithSample({ codec: "V_VP9", sample: vp9Keyframe() }).buffer,
        "video/webm",
      ),
    ).toEqual({ mimeType: "video/webm", extension: "webm" });
  });

  it("rejects the four-byte VP9 false positive starting with 0x80", () => {
    expect(() =>
      inspectGeneratedVideo(
        webmWithSample({
          codec: "V_VP9",
          sample: Uint8Array.from([0x80, 0, 0, 0]),
        }).buffer,
        "video/webm",
      )
    ).toThrow(InvalidGeneratedVideoError);
  });

  it("accepts a WebM AV1 sequence header followed by a sized frame OBU", () => {
    expect(
      inspectGeneratedVideo(
        webmWithSample({ codec: "V_AV1", sample: av1Keyframe() }).buffer,
        "video/webm",
      ),
    ).toEqual({ mimeType: "video/webm", extension: "webm" });
  });

  it("rejects the AV1 false positive starting with a sequence-header OBU", () => {
    expect(() =>
      inspectGeneratedVideo(
        webmWithSample({
          codec: "V_AV1",
          sample: Uint8Array.from([0x0a, 0x02, 0x18, 0]),
        }).buffer,
        "video/webm",
      )
    ).toThrow(InvalidGeneratedVideoError);
  });

  it("rejects WebM metadata without a media cluster", () => {
    const complete = webmWithSample();
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

  it("rejects a WebM duration above the generated-video limit", () => {
    expect(() =>
      inspectGeneratedVideo(
        webmWithSample({ duration: 61 }).buffer,
        "video/webm",
      )
    ).toThrow(InvalidGeneratedVideoError);
  });

  it("rejects WebM block timing beyond the declared duration", () => {
    expect(() =>
      inspectGeneratedVideo(
        webmWithSample({ duration: 1, clusterTimestamp: 2 }).buffer,
        "video/webm",
      )
    ).toThrow(InvalidGeneratedVideoError);
  });

  it("bounds WebM parsing work for segments made of tiny elements", () => {
    const tinyElements = Array.from(
      { length: MAX_AI_VIDEO_PARSE_ITEMS },
      () => ebmlElement([0xec]),
    );

    expect(() =>
      inspectGeneratedVideo(
        webmWithSample({ extraSegmentElements: tinyElements }).buffer,
        "video/webm",
      )
    ).toThrow("parsing work limit");
  });

  it("rejects a declared container that disagrees with sniffed bytes", () => {
    expect(() =>
      inspectGeneratedVideo(validWebmBytes().buffer, "video/mp4")
    ).toThrow(InvalidGeneratedVideoError);
  });
});
