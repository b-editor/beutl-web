import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractAudioAsWav,
  extractionAudioContextOptions,
  downmixChannels,
  createAudioExtractionGate,
  createAudioExtractionSelectionController,
  maximumExtractableSeconds,
  maximumDecodedSeconds,
} from "../../apps/web/src/lib/audio-extract";

function installBrowserAudio(
  duration: number,
  decoded: {
    duration: number;
    length: number;
    numberOfChannels: number;
    sampleRate: number;
  },
  channelData: Float32Array[] = [],
) {
  const contextOptions: unknown[] = [];
  const video = {
    preload: "",
    muted: false,
    style: {},
    onloadedmetadata: null as (() => void) | null,
    onerror: null as (() => void) | null,
    duration,
    src: "",
    load() {
      this.onloadedmetadata?.();
    },
    remove() {},
  };
  vi.stubGlobal("document", {
    body: { appendChild() {} },
    createElement: () => video,
  });
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:audio",
    revokeObjectURL: () => undefined,
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor(options: unknown) {
        contextOptions.push(options);
      }
      async decodeAudioData() {
        return {
          ...decoded,
          getChannelData: (channel: number) =>
            channelData[channel] ?? new Float32Array(decoded.length),
        };
      }
      async close() {}
    },
  );
  return contextOptions;
}

describe("video audio extraction memory bounds", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("derives the displayed limit from the supported post-decode budget", () => {
    expect(maximumExtractableSeconds(25 * 1024 * 1024)).toBe(
      maximumDecodedSeconds(),
    );
    // 16 kHz x six supported channels x Float32. This limits the normal
    // post-decode buffer, but Web Audio cannot promise a hard pre-decode peak.
    expect(maximumDecodedSeconds()).toBe(
      Math.floor(96 * 1024 * 1024 / (16_000 * 6 * 4)),
    );
  });

  it("prevents a second decode until the first one finishes", () => {
    const gate = createAudioExtractionGate();
    expect(gate.tryStart()).toBe(true);
    expect(gate.tryStart()).toBe(false);
    expect(gate.isBusy()).toBe(true);
    gate.finish();
    expect(gate.tryStart()).toBe(true);
  });

  it("marks a newer selection current even while an older decode is busy", () => {
    const selection = createAudioExtractionSelectionController<string>();
    const first = selection.begin("first");
    const second = selection.begin("second");
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(selection.isCurrent(first.generation)).toBe(false);
    expect(selection.isCurrent(second.generation)).toBe(true);
    expect(selection.takeLatest()).toEqual({ generation: second.generation, value: "second" });
    selection.finish();
  });

  it("uses the normative mono downmix policy and excludes LFE", () => {
    const one = [Float32Array.from([0.75])];
    expect(downmixChannels(one, 0)).toBeCloseTo(0.75);
    expect(downmixChannels([
      Float32Array.from([1]),
      Float32Array.from([-1]),
    ], 0)).toBeCloseTo(0);
    expect(downmixChannels([
      Float32Array.from([1]),
      Float32Array.from([1]),
      Float32Array.from([1]),
      Float32Array.from([1]),
    ], 0)).toBeCloseTo(1);
    const fiveOne = [
      Float32Array.from([0]),
      Float32Array.from([0]),
      Float32Array.from([1]),
      Float32Array.from([1]),
      Float32Array.from([0]),
      Float32Array.from([0]),
    ];
    expect(downmixChannels(fiveOne, 0)).toBeCloseTo(1);
    fiveOne[2]![0] = 0;
    fiveOne[3]![0] = 1;
    expect(downmixChannels(fiveOne, 0)).toBeCloseTo(0);
    expect(() => downmixChannels([Float32Array.from([1])], 0)).not.toThrow();
    expect(() => downmixChannels([
      Float32Array.from([1]),
      Float32Array.from([1]),
      Float32Array.from([1]),
    ], 0)).toThrow("unsupportedFormat");
  });

  it("extracts a short mono clip", async () => {
    const contextOptions = installBrowserAudio(1, {
      duration: 1,
      length: 16_000,
      numberOfChannels: 1,
      sampleRate: 16_000,
    });
    const result = await extractAudioAsWav(
      new File([new Uint8Array(4)], "short.mp4", { type: "video/mp4" }),
      25 * 1024 * 1024,
    );
    expect(result.type).toBe("audio/wav");
    expect(result.size).toBe(44 + 16_000 * 2);
    expect(extractionAudioContextOptions()).toEqual({ sampleRate: 16_000 });
    expect(contextOptions).toEqual([{ sampleRate: 16_000 }]);
  });

  it("rejects a long clip before decoding its large PCM buffer", async () => {
    installBrowserAudio(maximumDecodedSeconds() + 1, {
      duration: maximumDecodedSeconds() + 1,
      length: 1,
      numberOfChannels: 2,
      sampleRate: 16_000,
    });
    const decode = vi.spyOn(AudioContext.prototype, "decodeAudioData");
    await expect(
      extractAudioAsWav(
        new File([new Uint8Array(4)], "long.mp4", { type: "video/mp4" }),
        25 * 1024 * 1024,
      ),
    ).rejects.toMatchObject({ reason: "tooLong" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("fails closed when container metadata does not provide a trusted duration", async () => {
    installBrowserAudio(Number.NaN, {
      duration: 1,
      length: 16_000,
      numberOfChannels: 2,
      sampleRate: 16_000,
    });
    const decode = vi.spyOn(AudioContext.prototype, "decodeAudioData");
    await expect(
      extractAudioAsWav(
        new File([new Uint8Array(4)], "unknown.mp4", { type: "video/mp4" }),
        25 * 1024 * 1024,
      ),
    ).rejects.toMatchObject({ reason: "unsupportedFormat" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects unsupported high-channel decoded PCM after decode", async () => {
    installBrowserAudio(1, {
      duration: 1,
      length: 1_000_000,
      numberOfChannels: 40,
      sampleRate: 16_000,
    });
    await expect(
      extractAudioAsWav(
        new File([new Uint8Array(4)], "surround.mp4", { type: "video/mp4" }),
        25 * 1024 * 1024,
      ),
    ).rejects.toMatchObject({ reason: "unsupportedFormat" });
  });

  it("rejects malformed decoded metadata instead of emitting an unbounded WAV", async () => {
    installBrowserAudio(1, {
      duration: Number.POSITIVE_INFINITY,
      length: 16_000,
      numberOfChannels: 2,
      sampleRate: 48_000,
    });
    await expect(
      extractAudioAsWav(
        new File([new Uint8Array(4)], "malformed.mp4", { type: "video/mp4" }),
        25 * 1024 * 1024,
      ),
    ).rejects.toMatchObject({ reason: "tooLong" });
  });

  it("writes center-only 5.1 and keeps LFE-only 5.1 silent", async () => {
    const decoded = {
      duration: 1,
      length: 1,
      numberOfChannels: 6,
      sampleRate: 16_000,
    };
    installBrowserAudio(1, decoded, [
      Float32Array.from([0]),
      Float32Array.from([0]),
      Float32Array.from([1]),
      Float32Array.from([0]),
      Float32Array.from([0]),
      Float32Array.from([0]),
    ]);
    const center = await extractAudioAsWav(
      new File([new Uint8Array(4)], "center.mp4", { type: "video/mp4" }),
      25 * 1024 * 1024,
    );
    const centerBytes = new DataView(await center.arrayBuffer());
    expect(centerBytes.getInt16(44, true)).toBeGreaterThan(30_000);

    installBrowserAudio(1, decoded, [
      Float32Array.from([0]),
      Float32Array.from([0]),
      Float32Array.from([0]),
      Float32Array.from([1]),
      Float32Array.from([0]),
      Float32Array.from([0]),
    ]);
    const lfe = await extractAudioAsWav(
      new File([new Uint8Array(4)], "lfe.mp4", { type: "video/mp4" }),
      25 * 1024 * 1024,
    );
    expect(new DataView(await lfe.arrayBuffer()).getInt16(44, true)).toBe(0);
  });
});
