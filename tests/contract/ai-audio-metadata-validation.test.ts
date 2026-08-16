import { describe, expect, it } from "vitest";
import {
  audioDurationValidators,
  MAX_AI_AUDIO_BYTES,
  parseAudio,
} from "../../packages/api/src/ai/audio-metadata";

const MPEG_1_LAYER_III_FRAME_LENGTH = 417;
const MPEG_1_LAYER_III_FRAME_DURATION = 1_152 / 44_100;

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

function mp3Frame(): Uint8Array {
  const frame = new Uint8Array(MPEG_1_LAYER_III_FRAME_LENGTH);
  frame.set([0xff, 0xfb, 0x90, 0]);
  return frame;
}

function mp3WithForgedFrameCount(marker: "Xing" | "Info"): Uint8Array {
  const frames = Array.from({ length: 12 }, () => mp3Frame());
  const firstFrame = frames[0];
  const view = new DataView(firstFrame.buffer);
  firstFrame.set(new TextEncoder().encode(marker), 36);
  view.setUint32(40, 0x03); // Frame-count and stream-size fields are present.
  view.setUint32(44, 1); // Forge a duration of only one frame.
  view.setUint32(48, MPEG_1_LAYER_III_FRAME_LENGTH);
  return join(...frames);
}

function emptyId3v2Tag(): Uint8Array {
  return Uint8Array.from([
    0x49,
    0x44,
    0x33,
    0x04,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}

function id3v1Tag(): Uint8Array {
  const tag = new Uint8Array(128);
  tag.set(new TextEncoder().encode("TAG"));
  return tag;
}

function pcmWav(sampleCount: number, trailingBytes = 0): Uint8Array {
  const bytes = new Uint8Array(44 + sampleCount * 2 + trailingBytes);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, sampleCount * 2, true);
  return bytes;
}

function adtsFrame(payloadLength = 1): Uint8Array {
  const frameLength = 7 + payloadLength;
  const bytes = new Uint8Array(frameLength);
  bytes.set([
    0xff,
    0xf1,
    0x50,
    0x80 | ((frameLength >> 11) & 0x03),
    (frameLength >> 3) & 0xff,
    ((frameLength & 0x07) << 5) | 0x1f,
    0xfc,
  ]);
  return bytes;
}

describe("MP3 duration validation", () => {
  it.each(["Xing", "Info"] as const)(
    "uses actual MPEG frames instead of a forged %s frame count",
    async (marker) => {
      const bytes = mp3WithForgedFrameCount(marker);

      const parsed = await parseAudio(
        new File([bytes], `forged-${marker}.mp3`, { type: "audio/mpeg" }),
      );

      expect(parsed.durationSeconds).toBeCloseTo(
        12 * MPEG_1_LAYER_III_FRAME_DURATION,
        12,
      );
      expect(parsed.durationSeconds).toBeGreaterThan(
        MPEG_1_LAYER_III_FRAME_DURATION,
      );
    },
  );

  it("scans frames between leading ID3v2 and trailing ID3v1 tags", async () => {
    const bytes = join(
      emptyId3v2Tag(),
      mp3Frame(),
      mp3Frame(),
      mp3Frame(),
      id3v1Tag(),
    );

    const parsed = await parseAudio(
      new File([bytes], "tagged.mp3", { type: "audio/mpeg" }),
    );

    expect(parsed.durationSeconds).toBeCloseTo(
      3 * MPEG_1_LAYER_III_FRAME_DURATION,
      12,
    );
  });

  it("rejects a truncated MPEG frame sequence", async () => {
    const bytes = join(mp3Frame(), mp3Frame().slice(0, -1));

    await expect(
      parseAudio(new File([bytes], "truncated.mp3", { type: "audio/mpeg" })),
    ).rejects.toThrow("MP3 frame sequence");
  });

  it("rejects a forged WAVE container size and trailing padding", () => {
    const forged = pcmWav(8_000, 1);
    new DataView(forged.buffer).setUint32(4, 44 + 16_000 - 8, true);

    expect(() => audioDurationValidators.wave(forged))
      .toThrow("container size");
  });

  it("derives ADTS duration from complete AAC frames", () => {
    expect(
      audioDurationValidators.adts(join(adtsFrame(), adtsFrame())),
    ).toBeCloseTo(2 * 1024 / 44_100, 12);
  });

  it.each([
    ["FLAC", "FLAC"],
    ["Ogg", "Opus"],
    ["M4A", "AAC"],
    ["Matroska", "Opus"],
  ])("rejects %s because header timing can be forged", (container, codec) => {
    expect(() =>
      audioDurationValidators.resolve(new Uint8Array(64), {
        container,
        codec,
      })).toThrow("cannot be verified safely");
  });

  it("rejects a WAVE header with a forged block alignment", () => {
    const forged = pcmWav(8_000);
    new DataView(forged.buffer).setUint16(32, 1, true);

    expect(() => audioDurationValidators.wave(forged))
      .toThrow("invalid audio parameters");
  });

  it("rejects oversized audio before reading the file", async () => {
    let read = false;
    const file = {
      size: MAX_AI_AUDIO_BYTES + 1,
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    } as File;

    await expect(parseAudio(file)).rejects.toThrow("file size");
    expect(read).toBe(false);
  });
});
