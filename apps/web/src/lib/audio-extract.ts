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

export type AudioExtractionFailure =
  | "unsupportedFormat"
  | "tooLong"
  | "noAudioTrack";

export class AudioExtractionError extends Error {
  constructor(readonly reason: AudioExtractionFailure) {
    super(`Audio extraction failed: ${reason}`);
    this.name = "AudioExtractionError";
  }
}

export function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/");
}

// How long a clip may be before its WAV would exceed the upload cap. Measured
// first, because decoding an hour of video only to refuse it would take the tab
// down with it.
export function maximumExtractableSeconds(maximumBytes: number): number {
  return Math.floor(maximumBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE));
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

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * BYTES_PER_SAMPLE);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * BYTES_PER_SAMPLE, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * BYTES_PER_SAMPLE, true);

  let offset = 44;
  for (const sample of samples) {
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
  const durationSeconds = await probeDurationSeconds(file);
  if (
    durationSeconds !== null &&
    durationSeconds > maximumExtractableSeconds(maximumBytes)
  ) {
    throw new AudioExtractionError("tooLong");
  }

  let decoded: AudioBuffer;
  try {
    const context = new AudioContext();
    try {
      decoded = await context.decodeAudioData(await file.arrayBuffer());
    } finally {
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

  // Resampling and downmixing in one pass, which is also what keeps the WAV
  // inside the cap the duration was measured against.
  const offline = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * SAMPLE_RATE),
    SAMPLE_RATE,
  );
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();

  const wav = encodeWav(rendered.getChannelData(0), SAMPLE_RATE);
  if (wav.byteLength > maximumBytes) {
    throw new AudioExtractionError("tooLong");
  }
  return new File([wav], `${file.name.replace(/\.[^.]+$/, "")}.wav`, {
    type: "audio/wav",
  });
}
