export const MAX_AI_GENERATED_VIDEO_BYTES = 32 * 1024 * 1024;
export const MAX_AI_VIDEO_PARSE_ITEMS = 16_384;
export const MAX_AI_GENERATED_VIDEO_DURATION_SECONDS = 60;
const VIDEO_DURATION_TOLERANCE_SECONDS = 0.05;

export type GeneratedVideoMimeType = "video/mp4" | "video/webm";
export type GeneratedVideoExtension = "mp4" | "webm";

export type VideoMetadata = {
  mimeType: GeneratedVideoMimeType;
  extension: GeneratedVideoExtension;
};

export class InvalidGeneratedVideoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidGeneratedVideoError";
  }
}

class ParseBudget {
  private remaining = MAX_AI_VIDEO_PARSE_ITEMS;

  consume(items = 1): void {
    if (
      !Number.isSafeInteger(items) ||
      items < 0 ||
      items > this.remaining
    ) {
      throw new InvalidGeneratedVideoError(
        "Generated video exceeds the container parsing work limit",
      );
    }
    this.remaining -= items;
  }
}

function hasAsciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index++) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let value = "";
  for (let offset = start; offset < end; offset++) {
    const byte = bytes[offset];
    if (byte < 0x20 || byte > 0x7e) {
      throw new InvalidGeneratedVideoError(
        "Generated video contains an invalid container identifier",
      );
    }
    value += String.fromCharCode(byte);
  }
  return value;
}

function hasNonZeroData(bytes: Uint8Array, start: number, end: number): boolean {
  const inspectedEnd = Math.min(end, start + 64);
  for (let offset = start; offset < inspectedEnd; offset++) {
    if (bytes[offset] !== 0) return true;
  }
  return false;
}

type IsoBox = {
  type: string;
  dataStart: number;
  end: number;
};

function parseIsoBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: ParseBudget,
): IsoBox[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: IsoBox[] = [];
  let offset = start;

  while (offset < end) {
    budget.consume();
    if (end - offset < 8) {
      throw new InvalidGeneratedVideoError("Generated MP4 box is truncated");
    }
    const size32 = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    let headerSize = 8;
    let size: number;
    if (size32 === 1) {
      if (end - offset < 16) {
        throw new InvalidGeneratedVideoError(
          "Generated MP4 extended box is truncated",
        );
      }
      const high = view.getUint32(offset + 8);
      const low = view.getUint32(offset + 12);
      size = high * 0x1_0000_0000 + low;
      headerSize = 16;
      if (!Number.isSafeInteger(size)) {
        throw new InvalidGeneratedVideoError(
          "Generated MP4 box size is invalid",
        );
      }
    } else if (size32 === 0) {
      size = end - offset;
    } else {
      size = size32;
    }

    const boxEnd = offset + size;
    if (size < headerSize || boxEnd < offset || boxEnd > end) {
      throw new InvalidGeneratedVideoError(
        "Generated MP4 box size is invalid",
      );
    }
    boxes.push({ type, dataStart: offset + headerSize, end: boxEnd });
    offset = boxEnd;
  }

  if (offset !== end) {
    throw new InvalidGeneratedVideoError("Generated MP4 structure is invalid");
  }
  return boxes;
}

function exactlyOneBox(
  boxes: IsoBox[],
  type: string,
  message: string,
): IsoBox {
  const matching = boxes.filter((box) => box.type === type);
  if (matching.length !== 1) {
    throw new InvalidGeneratedVideoError(message);
  }
  return matching[0];
}

function readUint64(view: DataView, offset: number): number {
  const value =
    view.getUint32(offset) * 0x1_0000_0000 + view.getUint32(offset + 4);
  if (!Number.isSafeInteger(value)) {
    throw new InvalidGeneratedVideoError("Generated MP4 integer is too large");
  }
  return value;
}

function readTimedFullBoxDuration(
  bytes: Uint8Array,
  box: IsoBox,
  description: string,
): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[box.dataStart];
  let timescale: number;
  let duration: number;
  if (version === 0 && box.end - box.dataStart >= 20) {
    timescale = view.getUint32(box.dataStart + 12);
    duration = view.getUint32(box.dataStart + 16);
  } else if (version === 1 && box.end - box.dataStart >= 32) {
    timescale = view.getUint32(box.dataStart + 20);
    duration = readUint64(view, box.dataStart + 24);
  } else {
    throw new InvalidGeneratedVideoError(
      `Generated MP4 ${description} is invalid`,
    );
  }
  if (timescale === 0 || duration === 0) {
    throw new InvalidGeneratedVideoError(
      `Generated MP4 ${description} has no duration`,
    );
  }
  const seconds = duration / timescale;
  if (
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > MAX_AI_GENERATED_VIDEO_DURATION_SECONDS
  ) {
    throw new InvalidGeneratedVideoError(
      `Generated MP4 ${description} duration is invalid`,
    );
  }
  return seconds;
}

function readTrackDuration(
  bytes: Uint8Array,
  box: IsoBox,
  movieTimescale: number,
): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[box.dataStart];
  let trackId: number;
  let duration: number;
  if (version === 0 && box.end - box.dataStart >= 24) {
    trackId = view.getUint32(box.dataStart + 12);
    duration = view.getUint32(box.dataStart + 20);
  } else if (version === 1 && box.end - box.dataStart >= 36) {
    trackId = view.getUint32(box.dataStart + 20);
    duration = readUint64(view, box.dataStart + 28);
  } else {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 video track header is invalid",
    );
  }
  if (trackId === 0 || duration === 0) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 video track header has no track or duration",
    );
  }
  const seconds = duration / movieTimescale;
  if (
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > MAX_AI_GENERATED_VIDEO_DURATION_SECONDS
  ) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 video track duration is invalid",
    );
  }
  return seconds;
}

function readTimedFullBoxTimescale(bytes: Uint8Array, box: IsoBox): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[box.dataStart];
  if (version === 0 && box.end - box.dataStart >= 20) {
    return view.getUint32(box.dataStart + 12);
  }
  if (version === 1 && box.end - box.dataStart >= 32) {
    return view.getUint32(box.dataStart + 20);
  }
  throw new InvalidGeneratedVideoError("Generated MP4 timed header is invalid");
}

function assertDurationsConsistent(
  description: string,
  expected: number,
  actual: number,
): void {
  if (Math.abs(expected - actual) > VIDEO_DURATION_TOLERANCE_SECONDS) {
    throw new InvalidGeneratedVideoError(
      `Generated MP4 ${description} durations are inconsistent`,
    );
  }
}

const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "iso8",
  "iso9",
  "avc1",
  "mp41",
  "mp42",
  "dash",
  "cmfc",
  "cmfs",
  "M4V ",
  "MSNV",
  "3gp4",
  "3gp5",
]);

const MP4_VIDEO_CONFIG_BOX: Record<string, string> = {
  avc1: "avcC",
  avc3: "avcC",
  hvc1: "hvcC",
  hev1: "hvcC",
  vp08: "vpcC",
  vp09: "vpcC",
  av01: "av1C",
  mp4v: "esds",
};

function isValidCodecConfiguration(
  bytes: Uint8Array,
  sampleType: string,
  box: IsoBox,
): boolean {
  const length = box.end - box.dataStart;
  switch (sampleType) {
    case "avc1":
    case "avc3":
      return length >= 7 && bytes[box.dataStart] === 1 &&
        (bytes[box.dataStart + 5] & 0x1f) > 0;
    case "hvc1":
    case "hev1":
      return length >= 23 && bytes[box.dataStart] === 1 &&
        bytes[box.dataStart + 22] > 0;
    case "vp08":
    case "vp09":
      return length >= 8 && hasNonZeroData(bytes, box.dataStart, box.end);
    case "av01":
      return length >= 4 && (bytes[box.dataStart] & 0x80) !== 0;
    case "mp4v":
      return length >= 5 && hasNonZeroData(bytes, box.dataStart, box.end);
    default:
      return false;
  }
}

type VideoSampleDescription = {
  sampleType: string;
  nalLengthSize?: number;
};

function videoSampleDescription(
  bytes: Uint8Array,
  sampleType: string,
  configuration: IsoBox,
): VideoSampleDescription | null {
  if (!isValidCodecConfiguration(bytes, sampleType, configuration)) {
    return null;
  }
  if (sampleType === "avc1" || sampleType === "avc3") {
    const nalLengthSize = (bytes[configuration.dataStart + 4] & 0x03) + 1;
    if (nalLengthSize === 3) return null;
    return { sampleType, nalLengthSize };
  }
  if (sampleType === "hvc1" || sampleType === "hev1") {
    return {
      sampleType,
      nalLengthSize: (bytes[configuration.dataStart + 21] & 0x03) + 1,
    };
  }
  return { sampleType };
}

function parseVideoSampleDescriptions(
  bytes: Uint8Array,
  box: IsoBox,
  budget: ParseBudget,
): Map<number, VideoSampleDescription> {
  if (box.end - box.dataStart < 8 || bytes[box.dataStart] !== 0) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 sample description table is invalid",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint32(box.dataStart + 4);
  const entries = parseIsoBoxes(bytes, box.dataStart + 8, box.end, budget);
  if (entryCount === 0 || entryCount !== entries.length) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 sample description count is invalid",
    );
  }

  const validDescriptions = new Map<number, VideoSampleDescription>();
  for (const [index, entry] of entries.entries()) {
    const configType = MP4_VIDEO_CONFIG_BOX[entry.type];
    if (!configType || entry.end - entry.dataStart < 78) continue;
    const dataReferenceIndex = view.getUint16(entry.dataStart + 6);
    const width = view.getUint16(entry.dataStart + 24);
    const height = view.getUint16(entry.dataStart + 26);
    if (dataReferenceIndex === 0 || width === 0 || height === 0) continue;
    const children = parseIsoBoxes(
      bytes,
      entry.dataStart + 78,
      entry.end,
      budget,
    );
    const configurations = children.filter((child) => child.type === configType);
    if (configurations.length === 1) {
      const description = videoSampleDescription(
        bytes,
        entry.type,
        configurations[0],
      );
      if (description) validDescriptions.set(index + 1, description);
    }
  }
  if (validDescriptions.size === 0) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 has no decodable video sample description",
    );
  }
  return validDescriptions;
}

type SampleSizes = {
  count: number;
  fixedSize: number;
  sizes: number[];
};

function parseSampleSizes(
  bytes: Uint8Array,
  box: IsoBox,
  budget: ParseBudget,
): SampleSizes {
  if (box.end - box.dataStart < 12 || bytes[box.dataStart] !== 0) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 sample size table is invalid",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fixedSize = view.getUint32(box.dataStart + 4);
  const count = view.getUint32(box.dataStart + 8);
  if (count === 0) {
    throw new InvalidGeneratedVideoError("Generated MP4 has no video samples");
  }
  budget.consume(count);
  if (fixedSize > 0) {
    if (box.end - box.dataStart !== 12) {
      throw new InvalidGeneratedVideoError(
        "Generated MP4 fixed sample size table is invalid",
      );
    }
    return { count, fixedSize, sizes: [] };
  }
  if (box.end - box.dataStart !== 12 + count * 4) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 variable sample size table is invalid",
    );
  }
  const sizes: number[] = [];
  for (let index = 0; index < count; index++) {
    const size = view.getUint32(box.dataStart + 12 + index * 4);
    if (size === 0) {
      throw new InvalidGeneratedVideoError(
        "Generated MP4 contains an empty video sample",
      );
    }
    sizes.push(size);
  }
  return { count, fixedSize, sizes };
}

function validateSampleTiming(
  bytes: Uint8Array,
  box: IsoBox,
  sampleCount: number,
  budget: ParseBudget,
  timescale: number,
): number {
  if (box.end - box.dataStart < 8 || bytes[box.dataStart] !== 0) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 sample timing table is invalid",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint32(box.dataStart + 4);
  budget.consume(entryCount);
  if (entryCount === 0 || box.end - box.dataStart !== 8 + entryCount * 8) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 sample timing count is invalid",
    );
  }
  let timedSamples = 0;
  let totalDuration = 0;
  for (let index = 0; index < entryCount; index++) {
    const offset = box.dataStart + 8 + index * 8;
    const count = view.getUint32(offset);
    const delta = view.getUint32(offset + 4);
    timedSamples += count;
    totalDuration += count * delta;
    if (
      count === 0 ||
      delta === 0 ||
      !Number.isSafeInteger(timedSamples) ||
      timedSamples > sampleCount ||
      !Number.isSafeInteger(totalDuration)
    ) {
      throw new InvalidGeneratedVideoError(
        "Generated MP4 sample timing is invalid",
      );
    }
  }
  if (timedSamples !== sampleCount) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 sample timing does not cover its samples",
    );
  }
  const seconds = totalDuration / timescale;
  if (
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > MAX_AI_GENERATED_VIDEO_DURATION_SECONDS
  ) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 sample duration is invalid",
    );
  }
  return seconds;
}

type SampleToChunk = {
  firstChunk: number;
  samplesPerChunk: number;
  descriptionIndex: number;
};

function parseSampleToChunk(
  bytes: Uint8Array,
  box: IsoBox,
  validDescriptions: Map<number, VideoSampleDescription>,
  budget: ParseBudget,
): SampleToChunk[] {
  if (box.end - box.dataStart < 8 || bytes[box.dataStart] !== 0) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 sample-to-chunk table is invalid",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint32(box.dataStart + 4);
  budget.consume(entryCount);
  if (entryCount === 0 || box.end - box.dataStart !== 8 + entryCount * 12) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 sample-to-chunk count is invalid",
    );
  }
  const entries: SampleToChunk[] = [];
  for (let index = 0; index < entryCount; index++) {
    const offset = box.dataStart + 8 + index * 12;
    const entry = {
      firstChunk: view.getUint32(offset),
      samplesPerChunk: view.getUint32(offset + 4),
      descriptionIndex: view.getUint32(offset + 8),
    };
    if (
      entry.firstChunk === 0 ||
      entry.samplesPerChunk === 0 ||
      !validDescriptions.has(entry.descriptionIndex) ||
      (index === 0 && entry.firstChunk !== 1) ||
      (index > 0 && entry.firstChunk <= entries[index - 1].firstChunk)
    ) {
      throw new InvalidGeneratedVideoError(
        "Generated MP4 sample-to-chunk entry is invalid",
      );
    }
    entries.push(entry);
  }
  return entries;
}

function parseChunkOffsets(
  bytes: Uint8Array,
  box: IsoBox,
  budget: ParseBudget,
): number[] {
  if (box.end - box.dataStart < 8 || bytes[box.dataStart] !== 0) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 chunk offset table is invalid",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint32(box.dataStart + 4);
  const entrySize = box.type === "co64" ? 8 : 4;
  budget.consume(entryCount);
  if (entryCount === 0 || box.end - box.dataStart !== 8 + entryCount * entrySize) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 chunk offset count is invalid",
    );
  }
  const offsets: number[] = [];
  for (let index = 0; index < entryCount; index++) {
    const offset = box.dataStart + 8 + index * entrySize;
    offsets.push(
      entrySize === 8 ? readUint64(view, offset) : view.getUint32(offset),
    );
  }
  return offsets;
}

function readBigEndianInteger(
  bytes: Uint8Array,
  offset: number,
  length: number,
): number {
  let value = 0;
  for (let index = 0; index < length; index++) {
    value = value * 256 + bytes[offset + index];
  }
  return value;
}

function validateLengthPrefixedNalSample(
  bytes: Uint8Array,
  start: number,
  end: number,
  description: VideoSampleDescription,
  budget: ParseBudget,
): boolean {
  const lengthSize = description.nalLengthSize;
  if (!lengthSize) return false;
  let offset = start;
  let sawRandomAccessUnit = false;
  let sawVideoSlice = false;
  while (offset < end) {
    budget.consume();
    if (end - offset < lengthSize) {
      throw new InvalidGeneratedVideoError(
        "Generated MP4 video sample has a truncated NAL length",
      );
    }
    const nalLength = readBigEndianInteger(bytes, offset, lengthSize);
    offset += lengthSize;
    const nalEnd = offset + nalLength;
    if (nalLength === 0 || nalEnd > end || nalEnd < offset) {
      throw new InvalidGeneratedVideoError(
        "Generated MP4 video sample has an invalid NAL unit",
      );
    }

    if (description.sampleType === "avc1" || description.sampleType === "avc3") {
      if (nalLength < 2) {
        throw new InvalidGeneratedVideoError(
          "Generated MP4 AVC sample has a truncated NAL unit",
        );
      }
      const header = bytes[offset];
      const nalType = header & 0x1f;
      if ((header & 0x80) !== 0 || nalType === 0 || nalType > 23) {
        throw new InvalidGeneratedVideoError(
          "Generated MP4 AVC sample has an invalid NAL header",
        );
      }
      sawVideoSlice ||= nalType >= 1 && nalType <= 5;
      sawRandomAccessUnit ||= nalType === 5;
    } else {
      if (nalLength < 2) {
        throw new InvalidGeneratedVideoError(
          "Generated MP4 HEVC sample has a truncated NAL header",
        );
      }
      const nalType = (bytes[offset] >> 1) & 0x3f;
      if ((bytes[offset] & 0x80) !== 0 || (bytes[offset + 1] & 0x07) === 0) {
        throw new InvalidGeneratedVideoError(
          "Generated MP4 HEVC sample has an invalid NAL header",
        );
      }
      sawVideoSlice ||= nalType <= 31;
      sawRandomAccessUnit ||= nalType >= 16 && nalType <= 21;
    }
    offset = nalEnd;
  }
  if (!sawVideoSlice) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 video sample has no coded video slice",
    );
  }
  return sawRandomAccessUnit;
}

function validateVp8Sample(
  bytes: Uint8Array,
  start: number,
  end: number,
): boolean {
  if (end - start < 3 || ((bytes[start] >> 1) & 0x07) > 3) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 VP8 sample header is invalid",
    );
  }
  const isKeyframe = (bytes[start] & 1) === 0;
  if (!isKeyframe) return false;
  if (
    end - start < 10 ||
    bytes[start + 3] !== 0x9d ||
    bytes[start + 4] !== 0x01 ||
    bytes[start + 5] !== 0x2a ||
    ((bytes[start + 6] | (bytes[start + 7] << 8)) & 0x3fff) === 0 ||
    ((bytes[start + 8] | (bytes[start + 9] << 8)) & 0x3fff) === 0
  ) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 VP8 keyframe is invalid",
    );
  }
  return true;
}

class MostSignificantBitReader {
  private bitOffset: number;
  private readonly endBit: number;

  constructor(
    private readonly bytes: Uint8Array,
    start: number,
    end: number,
    private readonly description: string,
  ) {
    this.bitOffset = start * 8;
    this.endBit = end * 8;
  }

  read(count: number): number {
    if (count < 1 || count > 24 || this.bitOffset + count > this.endBit) {
      throw new InvalidGeneratedVideoError(
        `Generated ${this.description} header is truncated`,
      );
    }
    let value = 0;
    for (let index = 0; index < count; index++) {
      value = value * 2 +
        ((this.bytes[this.bitOffset >> 3] >> (7 - (this.bitOffset & 7))) & 1);
      this.bitOffset++;
    }
    return value;
  }
}

function validateVp9Sample(
  bytes: Uint8Array,
  start: number,
  end: number,
  expectedWidth?: number,
  expectedHeight?: number,
): boolean {
  const reader = new MostSignificantBitReader(bytes, start, end, "VP9 sample");
  if (reader.read(2) !== 2) {
    throw new InvalidGeneratedVideoError(
      "Generated VP9 sample frame marker is invalid",
    );
  }
  let profile = reader.read(1) | (reader.read(1) << 1);
  if (profile === 3) profile += reader.read(1);
  if (profile > 3 || reader.read(1) !== 0) {
    throw new InvalidGeneratedVideoError(
      "Generated VP9 sample profile or show-existing-frame flag is invalid",
    );
  }
  const isKeyframe = reader.read(1) === 0;
  const showFrame = reader.read(1) === 1;
  reader.read(1); // error_resilient_mode
  if (!isKeyframe) return false;
  if (!showFrame || reader.read(24) !== 0x49_83_42) {
    throw new InvalidGeneratedVideoError(
      "Generated VP9 keyframe sync header is invalid",
    );
  }

  if (profile >= 2) reader.read(1); // ten_or_twelve_bit
  const colorSpace = reader.read(3);
  if (colorSpace !== 7) {
    reader.read(1); // color_range
    if (profile === 1 || profile === 3) {
      const subsamplingX = reader.read(1);
      const subsamplingY = reader.read(1);
      if ((subsamplingX === 1 && subsamplingY === 1) || reader.read(1) !== 0) {
        throw new InvalidGeneratedVideoError(
          "Generated VP9 keyframe color configuration is invalid",
        );
      }
    }
  } else if (
    (profile !== 1 && profile !== 3) ||
    reader.read(1) !== 0
  ) {
    throw new InvalidGeneratedVideoError(
      "Generated VP9 keyframe RGB configuration is invalid",
    );
  }

  const width = reader.read(16) + 1;
  const height = reader.read(16) + 1;
  if (
    (expectedWidth !== undefined && width !== expectedWidth) ||
    (expectedHeight !== undefined && height !== expectedHeight)
  ) {
    throw new InvalidGeneratedVideoError(
      "Generated VP9 keyframe dimensions do not match its video track",
    );
  }
  if (reader.read(1) === 1) {
    const renderWidth = reader.read(16) + 1;
    const renderHeight = reader.read(16) + 1;
    if (renderWidth === 0 || renderHeight === 0) {
      throw new InvalidGeneratedVideoError(
        "Generated VP9 keyframe render dimensions are invalid",
      );
    }
  }
  return true;
}

function hasNonZeroByte(bytes: Uint8Array, start: number, end: number): boolean {
  for (let offset = start; offset < end; offset++) {
    if (bytes[offset] !== 0) return true;
  }
  return false;
}

function validateAv1SequenceHeader(
  bytes: Uint8Array,
  start: number,
  end: number,
): void {
  const reader = new MostSignificantBitReader(
    bytes,
    start,
    end,
    "AV1 sequence",
  );
  if (reader.read(3) > 2) {
    throw new InvalidGeneratedVideoError(
      "Generated AV1 sequence profile is invalid",
    );
  }
  const stillPicture = reader.read(1) === 1;
  const reducedStillPictureHeader = reader.read(1) === 1;
  if (reducedStillPictureHeader) {
    if (!stillPicture) {
      throw new InvalidGeneratedVideoError(
        "Generated AV1 reduced sequence header is invalid",
      );
    }
    reader.read(5); // seq_level_idx[0]
  }
}

function validateAv1Sample(
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: ParseBudget,
): boolean {
  let offset = start;
  let sawSequenceHeader = false;
  let sawFrameHeader = false;
  let sawCompleteFrame = false;
  while (offset < end) {
    budget.consume();
    const header = bytes[offset++];
    const obuType = (header >> 3) & 0x0f;
    const hasExtension = (header & 0x04) !== 0;
    const hasSize = (header & 0x02) !== 0;
    if (
      (header & 0x81) !== 0 ||
      obuType === 0 ||
      (obuType >= 9 && obuType <= 14) ||
      !hasSize
    ) {
      throw new InvalidGeneratedVideoError(
        "Generated AV1 OBU header is invalid",
      );
    }
    let temporalId = 0;
    let spatialId = 0;
    if (hasExtension) {
      if (offset >= end) {
        throw new InvalidGeneratedVideoError(
          "Generated AV1 OBU extension is truncated",
        );
      }
      const extension = bytes[offset++];
      temporalId = extension >> 5;
      spatialId = (extension >> 3) & 0x03;
      if (
        (extension & 0x07) !== 0 ||
        obuType === 1 ||
        obuType === 2 ||
        obuType === 8
      ) {
        throw new InvalidGeneratedVideoError(
          "Generated AV1 OBU extension is invalid",
        );
      }
    }
    let size = 0;
    let shift = 0;
    let terminated = false;
    let sizeBytes = 0;
    for (let index = 0; index < 8 && offset < end; index++) {
      const value = bytes[offset++];
      sizeBytes++;
      size += (value & 0x7f) * 2 ** shift;
      if ((value & 0x80) === 0) {
        terminated = true;
        if (sizeBytes > 1 && value === 0) terminated = false;
        break;
      }
      shift += 7;
    }
    const obuEnd = offset + size;
    if (
      !terminated ||
      !Number.isSafeInteger(size) ||
      !Number.isSafeInteger(obuEnd) ||
      obuEnd > end ||
      (size === 0 && obuType !== 2 && obuType !== 15)
    ) {
      throw new InvalidGeneratedVideoError(
        "Generated AV1 OBU size is invalid",
      );
    }

    if (obuType === 1) {
      if (sawFrameHeader || sawCompleteFrame || !hasNonZeroByte(bytes, offset, obuEnd)) {
        throw new InvalidGeneratedVideoError(
          "Generated AV1 sequence header is misplaced or empty",
        );
      }
      validateAv1SequenceHeader(bytes, offset, obuEnd);
      sawSequenceHeader = true;
    } else if (obuType === 3 || obuType === 6) {
      if (
        !sawSequenceHeader ||
        sawFrameHeader ||
        sawCompleteFrame ||
        size === 0 ||
        !hasNonZeroByte(bytes, offset, obuEnd) ||
        (hasExtension && (temporalId !== 0 || spatialId !== 0))
      ) {
        throw new InvalidGeneratedVideoError(
          "Generated AV1 frame OBU is invalid or precedes its sequence header",
        );
      }
      if (obuType === 3) sawFrameHeader = true;
      else sawCompleteFrame = true;
    } else if (obuType === 4 && sawFrameHeader) {
      if (size === 0 || !hasNonZeroByte(bytes, offset, obuEnd)) {
        throw new InvalidGeneratedVideoError(
          "Generated AV1 tile group is empty",
        );
      }
      sawCompleteFrame = true;
      sawFrameHeader = false;
    }
    offset = obuEnd;
  }
  return sawSequenceHeader && sawCompleteFrame && !sawFrameHeader;
}

function validateMpeg4VisualSample(
  bytes: Uint8Array,
  start: number,
  end: number,
): boolean {
  for (let offset = start; offset + 3 < end; offset++) {
    if (
      bytes[offset] === 0 &&
      bytes[offset + 1] === 0 &&
      bytes[offset + 2] === 1 &&
      bytes[offset + 3] === 0xb6
    ) {
      return true;
    }
  }
  throw new InvalidGeneratedVideoError(
    "Generated MP4 MPEG-4 Visual sample has no VOP start code",
  );
}

function validateMp4VideoSample(
  bytes: Uint8Array,
  start: number,
  end: number,
  description: VideoSampleDescription,
  budget: ParseBudget,
): boolean {
  switch (description.sampleType) {
    case "avc1":
    case "avc3":
    case "hvc1":
    case "hev1":
      return validateLengthPrefixedNalSample(
        bytes,
        start,
        end,
        description,
        budget,
      );
    case "vp08":
      return validateVp8Sample(bytes, start, end);
    case "vp09":
      return validateVp9Sample(bytes, start, end);
    case "av01":
      return validateAv1Sample(bytes, start, end, budget);
    case "mp4v":
      return validateMpeg4VisualSample(bytes, start, end);
    default:
      return false;
  }
}

function inspectVideoSampleTable(
  bytes: Uint8Array,
  minimumInformation: IsoBox,
  mediaRanges: Array<{ start: number; end: number }>,
  mediaTimescale: number,
  mediaDurationSeconds: number,
  budget: ParseBudget,
): void {
  const minimumChildren = parseIsoBoxes(
    bytes,
    minimumInformation.dataStart,
    minimumInformation.end,
    budget,
  );
  const sampleTable = exactlyOneBox(
    minimumChildren,
    "stbl",
    "Generated MP4 video track has no sample table",
  );
  const boxes = parseIsoBoxes(bytes, sampleTable.dataStart, sampleTable.end, budget);
  const descriptions = parseVideoSampleDescriptions(
    bytes,
    exactlyOneBox(
      boxes,
      "stsd",
      "Generated MP4 video track has no sample descriptions",
    ),
    budget,
  );
  const sizes = parseSampleSizes(
    bytes,
    exactlyOneBox(
      boxes,
      "stsz",
      "Generated MP4 video track has no sample sizes",
    ),
    budget,
  );
  const sampleDurationSeconds = validateSampleTiming(
    bytes,
    exactlyOneBox(
      boxes,
      "stts",
      "Generated MP4 video track has no sample timing",
    ),
    sizes.count,
    budget,
    mediaTimescale,
  );
  assertDurationsConsistent(
    "media header and sample table",
    mediaDurationSeconds,
    sampleDurationSeconds,
  );
  const sampleToChunk = parseSampleToChunk(
    bytes,
    exactlyOneBox(
      boxes,
      "stsc",
      "Generated MP4 video track has no sample-to-chunk table",
    ),
    descriptions,
    budget,
  );
  const offsetBoxes = boxes.filter(
    (box) => box.type === "stco" || box.type === "co64",
  );
  if (offsetBoxes.length !== 1) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 video track has no unique chunk offset table",
    );
  }
  const chunkOffsets = parseChunkOffsets(bytes, offsetBoxes[0], budget);

  let sampleIndex = 0;
  let mappingIndex = 0;
  let sawRandomAccessSample = false;
  for (let chunkIndex = 1; chunkIndex <= chunkOffsets.length; chunkIndex++) {
    while (
      mappingIndex + 1 < sampleToChunk.length &&
      sampleToChunk[mappingIndex + 1].firstChunk <= chunkIndex
    ) {
      mappingIndex++;
    }
    const mapping = sampleToChunk[mappingIndex];
    let sampleOffset = chunkOffsets[chunkIndex - 1];
    for (let index = 0; index < mapping.samplesPerChunk; index++) {
      if (sampleIndex >= sizes.count) {
        throw new InvalidGeneratedVideoError(
          "Generated MP4 chunk table references too many samples",
        );
      }
      const sampleSize = sizes.fixedSize || sizes.sizes[sampleIndex];
      const sampleEnd = sampleOffset + sampleSize;
      const range = mediaRanges.find(
        (candidate) =>
          sampleOffset >= candidate.start && sampleEnd <= candidate.end,
      );
      if (!Number.isSafeInteger(sampleEnd) || !range) {
        throw new InvalidGeneratedVideoError(
          "Generated MP4 sample is outside its media payload",
        );
      }
      const description = descriptions.get(mapping.descriptionIndex);
      if (!description) {
        throw new InvalidGeneratedVideoError(
          "Generated MP4 sample references an invalid description",
        );
      }
      sawRandomAccessSample ||= validateMp4VideoSample(
        bytes,
        sampleOffset,
        sampleEnd,
        description,
        budget,
      );
      sampleOffset = sampleEnd;
      sampleIndex++;
    }
  }
  if (sampleIndex !== sizes.count || !sawRandomAccessSample) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 has no meaningful decodable video sample",
    );
  }
}

function inspectMp4(bytes: Uint8Array): void {
  const budget = new ParseBudget();
  const boxes = parseIsoBoxes(bytes, 0, bytes.length, budget);
  const fileType = boxes[0];
  if (
    !fileType ||
    fileType.type !== "ftyp" ||
    fileType.end - fileType.dataStart < 12 ||
    (fileType.end - fileType.dataStart) % 4 !== 0
  ) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 has no valid file type box",
    );
  }

  const brands: string[] = [];
  brands.push(ascii(bytes, fileType.dataStart, fileType.dataStart + 4));
  for (let offset = fileType.dataStart + 8; offset < fileType.end; offset += 4) {
    brands.push(ascii(bytes, offset, offset + 4));
  }
  if (!brands.some((brand) => MP4_BRANDS.has(brand))) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 has no compatible MP4 brand",
    );
  }
  if (boxes.filter((box) => box.type === "ftyp").length !== 1) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 has duplicate file type boxes",
    );
  }

  const movie = exactlyOneBox(
    boxes,
    "moov",
    "Generated MP4 must contain exactly one movie box",
  );
  const mediaRanges = boxes
    .filter((box) => box.type === "mdat" && box.end > box.dataStart)
    .map((box) => ({ start: box.dataStart, end: box.end }));
  if (mediaRanges.length === 0) {
    throw new InvalidGeneratedVideoError("Generated MP4 has no media payload");
  }

  const movieChildren = parseIsoBoxes(bytes, movie.dataStart, movie.end, budget);
  const movieHeader = exactlyOneBox(
      movieChildren,
      "mvhd",
      "Generated MP4 has no unique movie header",
    );
  const movieDurationSeconds = readTimedFullBoxDuration(
    bytes,
    movieHeader,
    "movie header",
  );
  const movieTimescale = readTimedFullBoxTimescale(bytes, movieHeader);

  let sawVideoTrack = false;
  for (const track of movieChildren.filter((box) => box.type === "trak")) {
    const trackChildren = parseIsoBoxes(bytes, track.dataStart, track.end, budget);
    for (const media of trackChildren.filter((box) => box.type === "mdia")) {
      const mediaChildren = parseIsoBoxes(bytes, media.dataStart, media.end, budget);
      const handlers = mediaChildren.filter((box) => box.type === "hdlr");
      if (
        handlers.length !== 1 ||
        handlers[0].end - handlers[0].dataStart < 12 ||
        !hasAsciiAt(bytes, handlers[0].dataStart + 8, "vide")
      ) {
        continue;
      }
      const trackDurationSeconds = readTrackDuration(
        bytes,
        exactlyOneBox(
          trackChildren,
          "tkhd",
          "Generated MP4 video track has no unique track header",
        ),
        movieTimescale,
      );
      const mediaHeader = exactlyOneBox(
        mediaChildren,
        "mdhd",
        "Generated MP4 video track has no unique media header",
      );
      const mediaDurationSeconds = readTimedFullBoxDuration(
        bytes,
        mediaHeader,
        "media header",
      );
      const mediaTimescale = readTimedFullBoxTimescale(bytes, mediaHeader);
      assertDurationsConsistent(
        "movie and video track",
        movieDurationSeconds,
        trackDurationSeconds,
      );
      assertDurationsConsistent(
        "video track and media header",
        trackDurationSeconds,
        mediaDurationSeconds,
      );
      inspectVideoSampleTable(
        bytes,
        exactlyOneBox(
          mediaChildren,
          "minf",
          "Generated MP4 video track has no media information",
        ),
        mediaRanges,
        mediaTimescale,
        mediaDurationSeconds,
        budget,
      );
      sawVideoTrack = true;
    }
  }
  if (!sawVideoTrack) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 has no structurally valid video track",
    );
  }
}

type EbmlElement = {
  id: number;
  dataStart: number;
  end: number;
  unknownSize: boolean;
};

function vintLength(firstByte: number, maximumLength: number): number {
  for (let length = 1; length <= maximumLength; length++) {
    if ((firstByte & (0x80 >> (length - 1))) !== 0) return length;
  }
  throw new InvalidGeneratedVideoError("Generated WebM VINT is invalid");
}

function readEbmlId(
  bytes: Uint8Array,
  offset: number,
  end: number,
): { value: number; length: number } {
  if (offset >= end) {
    throw new InvalidGeneratedVideoError("Generated WebM element is truncated");
  }
  const length = vintLength(bytes[offset], 4);
  if (offset + length > end) {
    throw new InvalidGeneratedVideoError("Generated WebM ID is truncated");
  }
  let value = 0;
  for (let index = 0; index < length; index++) {
    value = value * 256 + bytes[offset + index];
  }
  return { value, length };
}

function readEbmlSize(
  bytes: Uint8Array,
  offset: number,
  end: number,
): { value: number; length: number; unknown: boolean } {
  if (offset >= end) {
    throw new InvalidGeneratedVideoError("Generated WebM size is truncated");
  }
  const length = vintLength(bytes[offset], 8);
  if (offset + length > end) {
    throw new InvalidGeneratedVideoError("Generated WebM size is truncated");
  }
  const marker = 0x80 >> (length - 1);
  let value = BigInt(bytes[offset] & (marker - 1));
  for (let index = 1; index < length; index++) {
    value = (value << BigInt(8)) | BigInt(bytes[offset + index]);
  }
  const unknownValue = (BigInt(1) << BigInt(7 * length)) - BigInt(1);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidGeneratedVideoError("Generated WebM size is invalid");
  }
  return {
    value: Number(value),
    length,
    unknown: value === unknownValue,
  };
}

function parseEbmlElements(
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: ParseBudget,
  allowUnknownLast = false,
): EbmlElement[] {
  const elements: EbmlElement[] = [];
  let offset = start;
  while (offset < end) {
    budget.consume();
    const id = readEbmlId(bytes, offset, end);
    const size = readEbmlSize(bytes, offset + id.length, end);
    const dataStart = offset + id.length + size.length;
    const elementEnd = size.unknown ? end : dataStart + size.value;
    if (
      dataStart > end ||
      elementEnd < dataStart ||
      elementEnd > end ||
      (size.unknown && !allowUnknownLast)
    ) {
      throw new InvalidGeneratedVideoError(
        "Generated WebM element size is invalid",
      );
    }
    elements.push({
      id: id.value,
      dataStart,
      end: elementEnd,
      unknownSize: size.unknown,
    });
    offset = elementEnd;
    if (size.unknown && offset !== end) {
      throw new InvalidGeneratedVideoError(
        "Generated WebM has a non-final unknown-size element",
      );
    }
  }
  return elements;
}

function exactlyOneElement(
  elements: EbmlElement[],
  id: number,
  message: string,
): EbmlElement {
  const matching = elements.filter((element) => element.id === id);
  if (matching.length !== 1) {
    throw new InvalidGeneratedVideoError(message);
  }
  return matching[0];
}

function ebmlText(bytes: Uint8Array, element: EbmlElement): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(element.dataStart, element.end),
    );
  } catch (cause) {
    throw new InvalidGeneratedVideoError("Generated WebM text is invalid", {
      cause,
    });
  }
}

function ebmlPaddedText(bytes: Uint8Array, element: EbmlElement): string {
  return ebmlText(bytes, element).replace(/\0+$/u, "");
}

function ebmlUnsigned(bytes: Uint8Array, element: EbmlElement): number {
  const length = element.end - element.dataStart;
  if (length < 1 || length > 8) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM integer is invalid",
    );
  }
  let value = BigInt(0);
  for (let offset = element.dataStart; offset < element.end; offset++) {
    value = (value << BigInt(8)) | BigInt(bytes[offset]);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM integer is too large",
    );
  }
  return Number(value);
}

function ebmlFloat(bytes: Uint8Array, element: EbmlElement): number {
  const length = element.end - element.dataStart;
  if (length !== 4 && length !== 8) {
    throw new InvalidGeneratedVideoError("Generated WebM float is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = length === 4
    ? view.getFloat32(element.dataStart)
    : view.getFloat64(element.dataStart);
  if (!Number.isFinite(value)) {
    throw new InvalidGeneratedVideoError("Generated WebM float is invalid");
  }
  return value;
}

function ebmlUnsignedIsNonZero(
  bytes: Uint8Array,
  element: EbmlElement,
): boolean {
  const length = element.end - element.dataStart;
  if (length < 1 || length > 8) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM integer is invalid",
    );
  }
  return hasNonZeroData(bytes, element.dataStart, element.end);
}

type WebmTrack = {
  type: number;
  codec: string;
  width?: number;
  height?: number;
};

const WEBM_VIDEO_CODECS = new Set(["V_VP8", "V_VP9", "V_AV1"]);

function inspectWebmTracks(
  bytes: Uint8Array,
  tracks: EbmlElement,
  budget: ParseBudget,
): Map<number, WebmTrack> {
  const entries = parseEbmlElements(
    bytes,
    tracks.dataStart,
    tracks.end,
    budget,
  ).filter((element) => element.id === 0xae);
  const trackMap = new Map<number, WebmTrack>();
  let sawVideoTrack = false;
  for (const entry of entries) {
    const fields = parseEbmlElements(bytes, entry.dataStart, entry.end, budget);
    const number = ebmlUnsigned(
      bytes,
      exactlyOneElement(
        fields,
        0xd7,
        "Generated WebM track has no unique track number",
      ),
    );
    const uidIsNonZero = ebmlUnsignedIsNonZero(
      bytes,
      exactlyOneElement(
        fields,
        0x73c5,
        "Generated WebM track has no unique track UID",
      ),
    );
    const type = ebmlUnsigned(
      bytes,
      exactlyOneElement(
        fields,
        0x83,
        "Generated WebM track has no unique track type",
      ),
    );
    const codec = ebmlPaddedText(
      bytes,
      exactlyOneElement(
        fields,
        0x86,
        "Generated WebM track has no unique codec",
      ),
    );
    if (number === 0 || !uidIsNonZero || trackMap.has(number)) {
      throw new InvalidGeneratedVideoError(
        "Generated WebM track identifier is invalid",
      );
    }
    const track: WebmTrack = { type, codec };
    if (type === 1) {
      if (!WEBM_VIDEO_CODECS.has(codec)) {
        throw new InvalidGeneratedVideoError(
          "Generated WebM video codec is unsupported",
        );
      }
      const video = exactlyOneElement(
        fields,
        0xe0,
        "Generated WebM video track has no unique video settings",
      );
      const videoFields = parseEbmlElements(
        bytes,
        video.dataStart,
        video.end,
        budget,
      );
      const width = ebmlUnsigned(
        bytes,
        exactlyOneElement(
          videoFields,
          0xb0,
          "Generated WebM video track has no width",
        ),
      );
      const height = ebmlUnsigned(
        bytes,
        exactlyOneElement(
          videoFields,
          0xba,
          "Generated WebM video track has no height",
        ),
      );
      if (width === 0 || height === 0) {
        throw new InvalidGeneratedVideoError(
          "Generated WebM video dimensions are invalid",
        );
      }
      track.width = width;
      track.height = height;
      sawVideoTrack = true;
    }
    trackMap.set(number, track);
  }
  if (!sawVideoTrack) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM has no structurally valid video track",
    );
  }
  return trackMap;
}

function validateWebmVideoSample(
  bytes: Uint8Array,
  track: WebmTrack,
  payloadStart: number,
  payloadEnd: number,
  budget: ParseBudget,
): void {
  if (payloadEnd - payloadStart < 4 || !hasNonZeroData(bytes, payloadStart, payloadEnd)) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM video sample is not meaningful",
    );
  }
  switch (track.codec) {
    case "V_VP8": {
      if (
        payloadEnd - payloadStart < 10 ||
        (bytes[payloadStart] & 1) !== 0 ||
        bytes[payloadStart + 3] !== 0x9d ||
        bytes[payloadStart + 4] !== 0x01 ||
        bytes[payloadStart + 5] !== 0x2a
      ) {
        throw new InvalidGeneratedVideoError(
          "Generated WebM VP8 keyframe is invalid",
        );
      }
      const width =
        (bytes[payloadStart + 6] | (bytes[payloadStart + 7] << 8)) & 0x3fff;
      const height =
        (bytes[payloadStart + 8] | (bytes[payloadStart + 9] << 8)) & 0x3fff;
      if (
        width === 0 ||
        height === 0 ||
        width !== track.width ||
        height !== track.height
      ) {
        throw new InvalidGeneratedVideoError(
          "Generated WebM VP8 keyframe dimensions are invalid",
        );
      }
      return;
    }
    case "V_VP9":
      if (
        !validateVp9Sample(
          bytes,
          payloadStart,
          payloadEnd,
          track.width,
          track.height,
        )
      ) {
        throw new InvalidGeneratedVideoError(
          "Generated WebM VP9 block is not a keyframe",
        );
      }
      return;
    case "V_AV1":
      if (!validateAv1Sample(bytes, payloadStart, payloadEnd, budget)) {
        throw new InvalidGeneratedVideoError(
          "Generated WebM AV1 block has no complete sequence and frame",
        );
      }
      return;
  }
}

function validateWebmBlock(
  bytes: Uint8Array,
  element: EbmlElement,
  tracks: Map<number, WebmTrack>,
  keyframe: boolean,
  budget: ParseBudget,
): { videoKeyframe: boolean } {
  const trackNumber = readEbmlSize(bytes, element.dataStart, element.end);
  const headerEnd = element.dataStart + trackNumber.length + 3;
  if (trackNumber.unknown || trackNumber.value < 1 || headerEnd > element.end) {
    throw new InvalidGeneratedVideoError("Generated WebM block is invalid");
  }
  const track = tracks.get(trackNumber.value);
  if (!track) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM block references an unknown track",
    );
  }
  const flags = bytes[element.dataStart + trackNumber.length + 2];
  if (track.type !== 1) {
    return { videoKeyframe: false };
  }
  if ((flags & 0x06) !== 0) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM video block uses unsupported lacing",
    );
  }
  if (keyframe) {
    validateWebmVideoSample(bytes, track, headerEnd, element.end, budget);
  }
  return { videoKeyframe: keyframe };
}

function inspectWebmCluster(
  bytes: Uint8Array,
  cluster: EbmlElement,
  tracks: Map<number, WebmTrack>,
  budget: ParseBudget,
): { timestamp: number; maximumRelativeTimestamp: number; videoKeyframe: boolean } {
  const fields = parseEbmlElements(bytes, cluster.dataStart, cluster.end, budget);
  const timestamp = ebmlUnsigned(
    bytes,
    exactlyOneElement(
      fields,
      0xe7,
      "Generated WebM cluster has no unique timestamp",
    ),
  );
  let sawBlock = false;
  let videoKeyframe = false;
  let maximumRelativeTimestamp = 0;
  for (const field of fields) {
    if (field.id === 0xa3) {
      const trackNumber = readEbmlSize(bytes, field.dataStart, field.end);
      const timestampOffset = field.dataStart + trackNumber.length;
      const flagsOffset = timestampOffset + 2;
      if (flagsOffset >= field.end) {
        throw new InvalidGeneratedVideoError("Generated WebM block is invalid");
      }
      const relativeTimestamp = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).getInt16(timestampOffset);
      if (relativeTimestamp < 0) {
        throw new InvalidGeneratedVideoError(
          "Generated WebM block timestamp is invalid",
        );
      }
      maximumRelativeTimestamp = Math.max(
        maximumRelativeTimestamp,
        relativeTimestamp,
      );
      const result = validateWebmBlock(
        bytes,
        field,
        tracks,
        (bytes[flagsOffset] & 0x80) !== 0,
        budget,
      );
      sawBlock = true;
      videoKeyframe ||= result.videoKeyframe;
    } else if (field.id === 0xa0) {
      const groupFields = parseEbmlElements(
        bytes,
        field.dataStart,
        field.end,
        budget,
      );
      const blocks = groupFields.filter((element) => element.id === 0xa1);
      if (blocks.length !== 1) {
        throw new InvalidGeneratedVideoError(
          "Generated WebM block group has no unique block",
        );
      }
      const trackNumber = readEbmlSize(
        bytes,
        blocks[0].dataStart,
        blocks[0].end,
      );
      const timestampOffset = blocks[0].dataStart + trackNumber.length;
      if (timestampOffset + 2 > blocks[0].end) {
        throw new InvalidGeneratedVideoError("Generated WebM block is invalid");
      }
      const relativeTimestamp = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).getInt16(timestampOffset);
      if (relativeTimestamp < 0) {
        throw new InvalidGeneratedVideoError(
          "Generated WebM block timestamp is invalid",
        );
      }
      maximumRelativeTimestamp = Math.max(
        maximumRelativeTimestamp,
        relativeTimestamp,
      );
      const result = validateWebmBlock(
        bytes,
        blocks[0],
        tracks,
        !groupFields.some((element) => element.id === 0xfb),
        budget,
      );
      sawBlock = true;
      videoKeyframe ||= result.videoKeyframe;
    }
  }
  if (!sawBlock) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM cluster has no media block",
    );
  }
  return { timestamp, maximumRelativeTimestamp, videoKeyframe };
}

function inspectWebm(bytes: Uint8Array): void {
  const budget = new ParseBudget();
  const headerId = readEbmlId(bytes, 0, bytes.length);
  if (headerId.value !== 0x1a45dfa3) {
    throw new InvalidGeneratedVideoError("Generated WebM header is invalid");
  }
  const headerSize = readEbmlSize(bytes, headerId.length, bytes.length);
  if (headerSize.unknown) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM header size is invalid",
    );
  }
  const headerStart = headerId.length + headerSize.length;
  const headerEnd = headerStart + headerSize.value;
  if (headerEnd > bytes.length) {
    throw new InvalidGeneratedVideoError("Generated WebM header is truncated");
  }
  const headerFields = parseEbmlElements(bytes, headerStart, headerEnd, budget);
  const documentType = exactlyOneElement(
    headerFields,
    0x4282,
    "Generated WebM document type is invalid",
  );
  if (ebmlPaddedText(bytes, documentType) !== "webm") {
    throw new InvalidGeneratedVideoError(
      "Generated WebM document type is invalid",
    );
  }

  const segmentId = readEbmlId(bytes, headerEnd, bytes.length);
  if (segmentId.value !== 0x18538067) {
    throw new InvalidGeneratedVideoError("Generated WebM has no segment");
  }
  const segmentSize = readEbmlSize(
    bytes,
    headerEnd + segmentId.length,
    bytes.length,
  );
  const segmentStart = headerEnd + segmentId.length + segmentSize.length;
  const segmentEnd = segmentSize.unknown
    ? bytes.length
    : segmentStart + segmentSize.value;
  if (segmentEnd !== bytes.length || segmentStart >= segmentEnd) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM segment size is invalid",
    );
  }
  const segmentFields = parseEbmlElements(
    bytes,
    segmentStart,
    segmentEnd,
    budget,
    true,
  );
  const info = exactlyOneElement(
    segmentFields,
    0x1549a966,
    "Generated WebM segment has no unique information element",
  );
  const tracks = exactlyOneElement(
    segmentFields,
    0x1654ae6b,
    "Generated WebM segment has no unique tracks element",
  );
  const clusters = segmentFields.filter((element) => element.id === 0x1f43b675);
  const infoIndex = segmentFields.indexOf(info);
  const tracksIndex = segmentFields.indexOf(tracks);
  const clusterIndex = clusters.length > 0 ? segmentFields.indexOf(clusters[0]) : -1;
  if (clusterIndex < 0 || infoIndex > clusterIndex || tracksIndex > clusterIndex) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM segment is missing required elements",
    );
  }
  const infoFields = parseEbmlElements(bytes, info.dataStart, info.end, budget);
  const timestampScales = infoFields.filter((element) => element.id === 0x2ad7b1);
  const durations = infoFields.filter((element) => element.id === 0x4489);
  if (
    timestampScales.length > 1 ||
    (timestampScales.length === 1 && ebmlUnsigned(bytes, timestampScales[0]) === 0)
  ) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM timestamp scale is invalid",
    );
  }
  if (durations.length !== 1) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM segment duration is missing or ambiguous",
    );
  }
  const timestampScale = timestampScales.length === 0
    ? 1_000_000
    : ebmlUnsigned(bytes, timestampScales[0]);
  const durationSeconds = ebmlFloat(bytes, durations[0]) * timestampScale /
    1_000_000_000;
  if (
    durationSeconds <= 0 ||
    durationSeconds > MAX_AI_GENERATED_VIDEO_DURATION_SECONDS
  ) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM segment duration is invalid",
    );
  }

  const trackMap = inspectWebmTracks(bytes, tracks, budget);
  let lastTimestamp = -1;
  let maximumBlockTimestamp = 0;
  let sawVideoKeyframe = false;
  for (const cluster of clusters) {
    const result = inspectWebmCluster(bytes, cluster, trackMap, budget);
    if (result.timestamp < lastTimestamp) {
      throw new InvalidGeneratedVideoError(
        "Generated WebM cluster timestamps are not monotonic",
      );
    }
    lastTimestamp = result.timestamp;
    maximumBlockTimestamp = Math.max(
      maximumBlockTimestamp,
      result.timestamp + result.maximumRelativeTimestamp,
    );
    sawVideoKeyframe ||= result.videoKeyframe;
  }
  const maximumBlockSeconds = maximumBlockTimestamp * timestampScale /
    1_000_000_000;
  if (maximumBlockSeconds > durationSeconds + VIDEO_DURATION_TOLERANCE_SECONDS) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM block timing exceeds its segment duration",
    );
  }
  if (!sawVideoKeyframe) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM has no meaningful decodable video keyframe",
    );
  }
}

function sniffVideoMimeType(bytes: Uint8Array): GeneratedVideoMimeType {
  if (bytes.length >= 8 && hasAsciiAt(bytes, 4, "ftyp")) {
    return "video/mp4";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "video/webm";
  }
  throw new InvalidGeneratedVideoError(
    "Generated video is not an MP4 or WebM container",
  );
}

export function inspectGeneratedVideo(
  value: ArrayBuffer,
  declaredMimeType: string,
): VideoMetadata {
  if (value.byteLength === 0 || value.byteLength > MAX_AI_GENERATED_VIDEO_BYTES) {
    throw new InvalidGeneratedVideoError("Generated video size is invalid");
  }
  const declared = declaredMimeType.split(";", 1)[0].trim().toLowerCase();
  if (declared !== "video/mp4" && declared !== "video/webm") {
    throw new InvalidGeneratedVideoError(
      `Generated video MIME type is unsupported: ${declared || "missing"}`,
    );
  }

  const bytes = new Uint8Array(value);
  const actual = sniffVideoMimeType(bytes);
  if (actual !== declared) {
    throw new InvalidGeneratedVideoError(
      `Generated video MIME mismatch: declared ${declared}, actual ${actual}`,
    );
  }
  if (actual === "video/mp4") {
    inspectMp4(bytes);
    return { mimeType: actual, extension: "mp4" };
  }
  inspectWebm(bytes);
  return { mimeType: actual, extension: "webm" };
}
