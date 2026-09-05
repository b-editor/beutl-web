// Turning a video into something the transcription endpoint will take.
//
// The endpoint refuses a file that carries video — it reads the container
// itself to confirm the duration it is charged for — so a video has to become
// audio before it is sent. Doing that here rather than server-side keeps the
// upload small: a 16 kHz mono WAV is what speech recognition wants anyway, and
// it is a fraction of the video it came from.

// Speech models resample to 16 kHz regardless, and one channel is enough to
// transcribe; both together are what keep the upload inside its cap.
const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const SUPPORTED_CHANNEL_COUNTS = [1, 2, 4, 6] as const;
const MAX_SUPPORTED_CHANNELS = Math.max(...SUPPORTED_CHANNEL_COUNTS);
// This is a post-decode rejection threshold, not a promise about browser peak
// memory. decodeAudioData accepts a complete compressed file and exposes its
// channel count only after allocating the AudioBuffer.
export const MAX_AUDIO_DECODED_PCM_BYTES = 96 * 1024 * 1024;
const BYTES_PER_DECODED_SAMPLE = 4;
let decodeQueue = Promise.resolve();

export type AudioExtractionFailure =
  | "unsupportedFormat"
  | "tooLong"
  | "tooLarge"
  | "noAudioTrack";

// 取り込む元の大きさ。長さの上限は、取り出したあとの音声にしかかからない
// ——短くても極端に高いビットレートの動画はいくらでも大きく、そのままだと
// 元のファイル、復号した PCM、詰め直した波形、WAV を同時に抱えることになり、
// This prevents the tab from failing before extraction. Compressed size cannot
// guarantee decoded size, but the source and temporary copies remain bounded.
export const MAX_AUDIO_SOURCE_BYTES = 32 * 1024 * 1024;

export class AudioExtractionError extends Error {
  constructor(readonly reason: AudioExtractionFailure) {
    super(`Audio extraction failed: ${reason}`);
    this.name = "AudioExtractionError";
  }
}

async function withDecodeSlot<T>(action: () => Promise<T>): Promise<T> {
  const previous = decodeQueue;
  let release!: () => void;
  decodeQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

export type AudioExtractionGate = {
  tryStart(): boolean;
  finish(): void;
  isBusy(): boolean;
};

export type AudioExtractionSelectionController<T> = {
  begin(value: T): { generation: number; accepted: boolean };
  takeLatest(): { generation: number; value: T } | null;
  isCurrent(generation: number): boolean;
  isBusy(): boolean;
  finish(): void;
};

export function createAudioExtractionGate(): AudioExtractionGate {
  let busy = false;
  return {
    tryStart() {
      if (busy) return false;
      busy = true;
      return true;
    },
    finish() {
      busy = false;
    },
    isBusy() {
      return busy;
    },
  };
}

export function createAudioExtractionSelectionController<T>():
  AudioExtractionSelectionController<T> {
  const gate = createAudioExtractionGate();
  let generation = 0;
  let pending: { generation: number; value: T } | null = null;
  return {
    begin(value) {
      const current = ++generation;
      pending = { generation: current, value };
      return { generation: current, accepted: gate.tryStart() };
    },
    takeLatest() {
      const current = pending;
      pending = null;
      return current;
    },
    isCurrent(current) {
      return current === generation;
    },
    isBusy() {
      return gate.isBusy();
    },
    finish() {
      gate.finish();
    },
  };
}

export function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/");
}

const DIRECT_TRANSCRIPTION_AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
  "audio/aac",
]);
const DIRECT_TRANSCRIPTION_AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".wave",
  ".aac",
  ".adts",
]);

export function isDirectTranscriptionAudioFile(file: File): boolean {
  const mediaType = file.type.trim().toLowerCase();
  if (mediaType) return DIRECT_TRANSCRIPTION_AUDIO_TYPES.has(mediaType);
  const name = file.name.trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 && DIRECT_TRANSCRIPTION_AUDIO_EXTENSIONS.has(name.slice(dot));
}

// How long a clip may be before its WAV would exceed the upload cap. Measured
// first, because decoding an hour of video only to refuse it would take the tab
// down with it.
export function maximumExtractableSeconds(maximumBytes: number): number {
  return Math.min(
    Math.floor(maximumBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE)),
    maximumDecodedSeconds(),
  );
}

export function maximumDecodedSeconds(): number {
  return Math.floor(
    MAX_AUDIO_DECODED_PCM_BYTES /
      (SAMPLE_RATE *
        MAX_SUPPORTED_CHANNELS *
        BYTES_PER_DECODED_SAMPLE),
  );
}

export function extractionAudioContextOptions(): AudioContextOptions {
  return { sampleRate: SAMPLE_RATE };
}

export function downmixChannels(
  channels: readonly Float32Array[],
  index: number,
): number {
  const value = (channel: number) => channels[channel]?.[index] ?? 0;
  switch (channels.length) {
    case 1:
      return value(0);
    case 2:
      return 0.5 * (value(0) + value(1));
    case 4:
      return 0.25 * (value(0) + value(1) + value(2) + value(3));
    case 6:
      // WAVEFORMATEXTENSIBLE order is L, R, C, LFE, SL, SR. LFE is
      // intentionally excluded from a speech mono mix.
      return Math.SQRT1_2 * (value(0) + value(1)) + value(2) +
        0.5 * (value(4) + value(5));
    default:
      throw new AudioExtractionError("unsupportedFormat");
  }
}

// A cheap look at how long the clip is, so an hour of video is refused before
// it is decoded rather than after. Best effort only: a detached media element
// never loads in some browsers, and one that says nothing must not stall the
// upload — the size of the finished WAV is what actually decides.
async function probeDurationSeconds(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  // Off-screen rather than detached: an element outside the document is not
  // guaranteed to load at all.
  video.style.position = "fixed";
  video.style.opacity = "0";
  video.style.pointerEvents = "none";
  document.body.appendChild(video);
  try {
    return await new Promise<number | null>((resolve) => {
      const done = (value: number | null) => resolve(value);
      const timer = window.setTimeout(() => done(null), 5_000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        done(Number.isFinite(video.duration) ? video.duration : null);
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        done(null);
      };
      video.src = url;
      video.load();
    });
  } finally {
    video.remove();
    URL.revokeObjectURL(url);
  }
}

function encodeDecodedWav(decoded: AudioBuffer): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + decoded.length * BYTES_PER_SAMPLE);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + decoded.length * BYTES_PER_SAMPLE, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true);
  writeAscii(36, "data");
  view.setUint32(40, decoded.length * BYTES_PER_SAMPLE, true);

  let offset = 44;
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) =>
    decoded.getChannelData(channel),
  );
  for (let index = 0; index < decoded.length; index++) {
    const sample = downmixChannels(channels, index);
    // Clamped before scaling: a value past ±1 would wrap into the opposite
    // sign and come out as a click.
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped * 0x7fff, true);
    offset += BYTES_PER_SAMPLE;
  }
  return buffer;
}

/**
 * The audio of a video file, as a 16 kHz mono WAV the endpoint accepts.
 *
 * Throws AudioExtractionError when the browser cannot decode the file, when it
 * carries no audio, or when the result would not fit within maximumBytes.
 */
export async function extractAudioAsWav(
  file: File,
  maximumBytes: number,
): Promise<File> {
  if (file.size > MAX_AUDIO_SOURCE_BYTES) {
    throw new AudioExtractionError("tooLarge");
  }

  const durationSeconds = await probeDurationSeconds(file);
  if (durationSeconds === null) {
    // Refuse unknown duration: decoding without a trusted duration could load a
    // long video into memory before the cap can be applied.
    throw new AudioExtractionError("unsupportedFormat");
  }
  if (durationSeconds > maximumExtractableSeconds(maximumBytes)) {
    throw new AudioExtractionError("tooLong");
  }
  if (durationSeconds > maximumDecodedSeconds()) {
    throw new AudioExtractionError("tooLong");
  }

  const wav = await withDecodeSlot(async () => {
    let decoded: AudioBuffer;
    let sourceBytes: ArrayBuffer | null = null;
    try {
      const context = new AudioContext(extractionAudioContextOptions());
      try {
        sourceBytes = await file.arrayBuffer();
        decoded = await context.decodeAudioData(sourceBytes);
      } finally {
        sourceBytes = null;
        await context.close();
      }
    } catch {
      // The browser demuxes and decodes here; a codec it does not know is the
      // usual reason, and there is nothing this page can do about it.
      throw new AudioExtractionError("unsupportedFormat");
    }
    if (decoded.numberOfChannels === 0 || decoded.length === 0) {
      throw new AudioExtractionError("noAudioTrack");
    }
    if (
      !SUPPORTED_CHANNEL_COUNTS.includes(
        decoded.numberOfChannels as (typeof SUPPORTED_CHANNEL_COUNTS)[number],
      )
    ) {
      throw new AudioExtractionError("unsupportedFormat");
    }
    if (
      !Number.isFinite(decoded.duration) ||
      decoded.duration <= 0 ||
      !Number.isFinite(decoded.sampleRate) ||
      decoded.sampleRate <= 0 ||
      decoded.sampleRate !== SAMPLE_RATE ||
      !Number.isSafeInteger(decoded.numberOfChannels) ||
      decoded.length * decoded.numberOfChannels * BYTES_PER_DECODED_SAMPLE >
        MAX_AUDIO_DECODED_PCM_BYTES
    ) {
      throw new AudioExtractionError("tooLong");
    }

    // decodeAudioData resamples into the requested context rate. Downmix while
    // writing the final PCM16 WAV, avoiding a second Float32 output buffer. The
    // source-size and metadata-duration checks above reduce the normal peak, but
    // cannot impose a hard decoder-memory limit: Web Audio reveals channel count
    // only after its complete-file decode has allocated this AudioBuffer.
    return encodeDecodedWav(decoded);
  });
  if (wav.byteLength > maximumBytes) {
    throw new AudioExtractionError("tooLong");
  }
  return new File([wav], `${file.name.replace(/\.[^.]+$/, "")}.wav`, {
    type: "audio/wav",
  });
}
