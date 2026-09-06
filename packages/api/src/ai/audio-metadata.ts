import { parseBuffer } from "music-metadata";
import { MAX_AI_TRANSCRIPTION_UPLOAD_BYTES } from "./upload-limits";

export type ParsedAudio = {
  bytes: ArrayBuffer;
  durationSeconds: number;
};

// Bound provider work and keep usage arithmetic inside the database Int range.
// Twenty-four hours is deliberately above normal editor use while rejecting
// malformed metadata that reports an effectively unbounded duration.
export const MAX_AI_AUDIO_DURATION_SECONDS = 24 * 60 * 60;
export const MAX_AI_AUDIO_BYTES = MAX_AI_TRANSCRIPTION_UPLOAD_BYTES;

const AAC_SAMPLE_RATES = [
  96_000,
  88_200,
  64_000,
  48_000,
  44_100,
  32_000,
  24_000,
  22_050,
  16_000,
  12_000,
  11_025,
  8_000,
  7_350,
] as const;

const MAX_AUDIO_CONTAINER_ITEMS = 65_536;
const MAX_PCM_WAVE_BYTES_PER_SECOND = 384_000 * 32 * 32 / 8;

const MPEG_1_LAYER_III_BITRATES = [
  0,
  32,
  40,
  48,
  56,
  64,
  80,
  96,
  112,
  128,
  160,
  192,
  224,
  256,
  320,
] as const;

const MPEG_2_LAYER_III_BITRATES = [
  0,
  8,
  16,
  24,
  32,
  40,
  48,
  56,
  64,
  80,
  96,
  112,
  128,
  144,
  160,
] as const;

const MPEG_SAMPLE_RATES = {
  1: [44_100, 48_000, 32_000],
  2: [22_050, 24_000, 16_000],
  2.5: [11_025, 12_000, 8_000],
} as const;

type Mp3FrameHeader = {
  frameLength: number;
  sampleRate: number;
  samplesPerFrame: number;
};

type AudioFormat = {
  container?: string;
  codec?: string;
  hasAudio?: boolean;
  hasVideo?: boolean;
};

function hasAsciiAt(
  bytes: Uint8Array,
  offset: number,
  value: string,
): boolean {
  if (offset < 0 || offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index++) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function readSynchsafeUint32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) {
    throw new Error("The MP3 ID3 header is truncated");
  }
  let value = 0;
  for (let index = 0; index < 4; index++) {
    const byte = bytes[offset + index];
    if ((byte & 0x80) !== 0) {
      throw new Error("The MP3 ID3 size is invalid");
    }
    value = value * 0x80 + byte;
  }
  return value;
}

function skipLeadingId3v2Tags(bytes: Uint8Array): number {
  let offset = 0;
  while (hasAsciiAt(bytes, offset, "ID3")) {
    if (offset + 10 > bytes.length) {
      throw new Error("The MP3 ID3 header is truncated");
    }
    const majorVersion = bytes[offset + 3];
    const flags = bytes[offset + 5];
    if (
      majorVersion < 2 ||
      majorVersion > 4 ||
      bytes[offset + 4] === 0xff ||
      (majorVersion === 2 && (flags & 0x3f) !== 0) ||
      (majorVersion === 3 && (flags & 0x1f) !== 0) ||
      (majorVersion === 4 && (flags & 0x0f) !== 0)
    ) {
      throw new Error("The MP3 ID3 header is invalid");
    }
    const hasFooter = majorVersion === 4 && (flags & 0x10) !== 0;
    const tagEnd = offset + 10 + readSynchsafeUint32(bytes, offset + 6) +
      (hasFooter ? 10 : 0);
    if (!Number.isSafeInteger(tagEnd) || tagEnd > bytes.length) {
      throw new Error("The MP3 ID3 tag is truncated");
    }
    if (hasFooter && !hasAsciiAt(bytes, tagEnd - 10, "3DI")) {
      throw new Error("The MP3 ID3 footer is invalid");
    }
    offset = tagEnd;
  }
  return offset;
}

function readMp3FrameHeader(
  bytes: Uint8Array,
  offset: number,
): Mp3FrameHeader | null {
  if (
    offset + 4 > bytes.length ||
    bytes[offset] !== 0xff ||
    (bytes[offset + 1] & 0xe0) !== 0xe0
  ) {
    return null;
  }

  const versionBits = (bytes[offset + 1] >> 3) & 0x03;
  const layerBits = (bytes[offset + 1] >> 1) & 0x03;
  const bitrateIndex = bytes[offset + 2] >> 4;
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
  if (
    versionBits === 1 ||
    layerBits !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 0x0f ||
    sampleRateIndex === 0x03
  ) {
    return null;
  }

  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const sampleRate = MPEG_SAMPLE_RATES[version][sampleRateIndex];
  const bitrateKbps = version === 1
    ? MPEG_1_LAYER_III_BITRATES[bitrateIndex]
    : MPEG_2_LAYER_III_BITRATES[bitrateIndex];
  const padding = (bytes[offset + 2] >> 1) & 1;
  const samplesPerFrame = version === 1 ? 1_152 : 576;
  const frameLength = Math.floor(
    (version === 1 ? 144 : 72) * bitrateKbps * 1_000 / sampleRate,
  ) + padding;
  if (frameLength <= 4) return null;
  return { frameLength, sampleRate, samplesPerFrame };
}

function verifiedMp3Duration(bytes: Uint8Array): number {
  let offset = skipLeadingId3v2Tags(bytes);
  let audioEnd = bytes.length;
  if (audioEnd - offset >= 128 && hasAsciiAt(bytes, audioEnd - 128, "TAG")) {
    audioEnd -= 128;
  }

  let durationSeconds = 0;
  let frameCount = 0;
  while (offset < audioEnd) {
    const header = readMp3FrameHeader(bytes, offset);
    if (!header || offset + header.frameLength > audioEnd) {
      throw new Error("The MP3 frame sequence is invalid");
    }
    durationSeconds += header.samplesPerFrame / header.sampleRate;
    frameCount++;
    offset += header.frameLength;
  }
  if (frameCount === 0 || offset !== audioEnd) {
    throw new Error("The MP3 frame sequence is empty or truncated");
  }
  return durationSeconds;
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new Error("The audio container is truncated");
  }
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true);
}

function verifiedWaveDuration(bytes: Uint8Array): number {
  if (
    bytes.length < 12 ||
    !hasAsciiAt(bytes, 0, "RIFF") ||
    !hasAsciiAt(bytes, 8, "WAVE")
  ) {
    throw new Error("The WAVE container header is invalid");
  }
  const declaredEnd = 8 + readUint32LittleEndian(bytes, 4);
  if (declaredEnd !== bytes.length) {
    throw new Error("The WAVE container size is invalid");
  }

  let blockAlign: number | null = null;
  let sampleRate: number | null = null;
  let dataBytes = 0;
  let dataChunkCount = 0;
  let offset = 12;
  let items = 0;
  while (offset < bytes.length) {
    if (++items > MAX_AUDIO_CONTAINER_ITEMS || offset + 8 > bytes.length) {
      throw new Error("The WAVE chunk table is invalid");
    }
    const size = readUint32LittleEndian(bytes, offset + 4);
    const dataStart = offset + 8;
    const end = dataStart + size;
    const paddedEnd = end + (size & 1);
    if (!Number.isSafeInteger(end) || paddedEnd > bytes.length) {
      throw new Error("The WAVE chunk is truncated");
    }
    if (hasAsciiAt(bytes, offset, "fmt ")) {
      if (size < 16 || blockAlign !== null || sampleRate !== null) {
        throw new Error("The WAVE format chunk is invalid");
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const format = view.getUint16(dataStart, true);
      const channels = view.getUint16(dataStart + 2, true);
      sampleRate = view.getUint32(dataStart + 4, true);
      const byteRate = view.getUint32(dataStart + 8, true);
      blockAlign = view.getUint16(dataStart + 12, true);
      const bitsPerSample = view.getUint16(dataStart + 14, true);
      const expectedBlockAlign = channels * bitsPerSample / 8;
      const expectedByteRate = sampleRate * expectedBlockAlign;
      if (
        format !== 1 ||
        channels === 0 ||
        channels > 32 ||
        sampleRate === 0 ||
        sampleRate > 384_000 ||
        ![8, 16, 24, 32].includes(bitsPerSample) ||
        !Number.isSafeInteger(expectedBlockAlign) ||
        blockAlign !== expectedBlockAlign ||
        !Number.isSafeInteger(expectedByteRate) ||
        expectedByteRate > MAX_PCM_WAVE_BYTES_PER_SECOND ||
        byteRate !== expectedByteRate
      ) {
        throw new Error("The WAVE format has invalid audio parameters");
      }
    } else if (hasAsciiAt(bytes, offset, "data")) {
      dataChunkCount++;
      if (
        dataChunkCount !== 1 ||
        size === 0 ||
        !Number.isSafeInteger(dataBytes + size)
      ) {
        throw new Error("The WAVE audio data size is invalid");
      }
      dataBytes += size;
    }
    offset = paddedEnd;
  }
  if (
    offset !== bytes.length ||
    blockAlign === null ||
    sampleRate === null ||
    dataChunkCount !== 1 ||
    dataBytes === 0 ||
    dataBytes % blockAlign !== 0
  ) {
    throw new Error("The WAVE audio data is invalid");
  }
  return dataBytes / blockAlign / sampleRate;
}

function verifiedAdtsDuration(bytes: Uint8Array): number {
  let offset = skipLeadingId3v2Tags(bytes);
  let durationSeconds = 0;
  let frameCount = 0;
  while (offset < bytes.length) {
    if (frameCount >= MAX_AUDIO_CONTAINER_ITEMS || offset + 7 > bytes.length) {
      throw new Error("The ADTS frame sequence is truncated");
    }
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xf6) !== 0xf0) {
      throw new Error("The ADTS frame header is invalid");
    }
    const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x0f;
    const sampleRate = AAC_SAMPLE_RATES[sampleRateIndex];
    const channelConfiguration = ((bytes[offset + 2] & 1) << 2) |
      (bytes[offset + 3] >> 6);
    const frameLength = ((bytes[offset + 3] & 0x03) << 11) |
      (bytes[offset + 4] << 3) |
      (bytes[offset + 5] >> 5);
    const headerLength = (bytes[offset + 1] & 1) === 1 ? 7 : 9;
    const rawBlocks = bytes[offset + 6] & 0x03;
    if (
      sampleRate === undefined ||
      channelConfiguration === 0 ||
      frameLength <= headerLength ||
      offset + frameLength > bytes.length
    ) {
      throw new Error("The ADTS frame is invalid");
    }
    durationSeconds += (rawBlocks + 1) * 1024 / sampleRate;
    frameCount++;
    offset += frameLength;
  }
  if (frameCount === 0 || offset !== bytes.length) {
    throw new Error("The ADTS frame sequence is empty or truncated");
  }
  return durationSeconds;
}

function verifiedAudioDuration(bytes: Uint8Array, format: AudioFormat): number {
  const container = format.container ?? "";
  if (container === "MPEG" && /Layer 3$/u.test(format.codec ?? "")) {
    return verifiedMp3Duration(bytes);
  }
  if (container === "WAVE") return verifiedWaveDuration(bytes);
  if (container.startsWith("ADTS/")) return verifiedAdtsDuration(bytes);
  throw new Error("The audio container cannot be verified safely");
}

export const audioDurationValidators = {
  adts: verifiedAdtsDuration,
  resolve: verifiedAudioDuration,
  wave: verifiedWaveDuration,
};

export async function parseAudio(file: File): Promise<ParsedAudio> {
  if (file.size === 0 || file.size > MAX_AI_AUDIO_BYTES) {
    throw new Error("The audio file size is invalid");
  }
  const bytes = await file.arrayBuffer();
  const metadata = await parseBuffer(
    new Uint8Array(bytes),
    {
      size: file.size,
      mimeType: file.type || undefined,
      path: file.name,
    },
    {
      duration: true,
      skipCovers: true,
    },
  );
  if (metadata.format.hasAudio === false || metadata.format.hasVideo === true) {
    throw new Error("The upload is not an audio-only file");
  }
  const durationSeconds = verifiedAudioDuration(
    new Uint8Array(bytes),
    metadata.format,
  );
  if (
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > MAX_AI_AUDIO_DURATION_SECONDS
  ) {
    throw new Error("The audio duration could not be determined");
  }

  return { bytes, durationSeconds };
}
