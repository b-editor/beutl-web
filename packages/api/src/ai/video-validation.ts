export const MAX_AI_GENERATED_VIDEO_BYTES = 32 * 1024 * 1024;

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

type IsoBox = {
  type: string;
  dataStart: number;
  end: number;
};

function parseIsoBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
): IsoBox[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: IsoBox[] = [];
  let offset = start;

  while (offset < end) {
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

function inspectMp4(bytes: Uint8Array): void {
  const boxes = parseIsoBoxes(bytes, 0, bytes.length);
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

  const movieBoxes = boxes.filter((box) => box.type === "moov");
  if (movieBoxes.length !== 1) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 must contain exactly one movie box",
    );
  }
  if (
    !boxes.some(
      (box) => box.type === "mdat" && box.end > box.dataStart,
    )
  ) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 has no media payload",
    );
  }

  const movieChildren = parseIsoBoxes(
    bytes,
    movieBoxes[0].dataStart,
    movieBoxes[0].end,
  );
  if (!movieChildren.some((box) => box.type === "mvhd")) {
    throw new InvalidGeneratedVideoError(
      "Generated MP4 has no movie header",
    );
  }

  let sawVideoTrack = false;
  for (const track of movieChildren.filter((box) => box.type === "trak")) {
    const trackChildren = parseIsoBoxes(bytes, track.dataStart, track.end);
    if (!trackChildren.some((box) => box.type === "tkhd")) continue;
    for (const media of trackChildren.filter((box) => box.type === "mdia")) {
      const mediaChildren = parseIsoBoxes(bytes, media.dataStart, media.end);
      if (
        !mediaChildren.some((box) => box.type === "mdhd") ||
        !mediaChildren.some((box) => box.type === "minf")
      ) {
        continue;
      }
      const handler = mediaChildren.find((box) => box.type === "hdlr");
      if (
        handler &&
        handler.end - handler.dataStart >= 12 &&
        hasAsciiAt(bytes, handler.dataStart + 8, "vide")
      ) {
        sawVideoTrack = true;
      }
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
  const unknownValue =
    (BigInt(1) << BigInt(7 * length)) - BigInt(1);
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
  allowUnknownLast = false,
): EbmlElement[] {
  const elements: EbmlElement[] = [];
  let offset = start;
  while (offset < end) {
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

function ebmlText(bytes: Uint8Array, element: EbmlElement): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(element.dataStart, element.end),
    );
  } catch (cause) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM text is invalid",
      { cause },
    );
  }
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

function validateWebmBlock(bytes: Uint8Array, element: EbmlElement): void {
  const track = readEbmlSize(bytes, element.dataStart, element.end);
  if (
    track.unknown ||
    track.value < 1 ||
    element.end - element.dataStart < track.length + 4
  ) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM block is invalid",
    );
  }
}

function inspectWebmTracks(bytes: Uint8Array, tracks: EbmlElement): void {
  const entries = parseEbmlElements(bytes, tracks.dataStart, tracks.end)
    .filter((element) => element.id === 0xae);
  let sawVideoTrack = false;
  for (const entry of entries) {
    const fields = parseEbmlElements(bytes, entry.dataStart, entry.end);
    const number = fields.find((element) => element.id === 0xd7);
    const type = fields.find((element) => element.id === 0x83);
    const codec = fields.find((element) => element.id === 0x86);
    const video = fields.find((element) => element.id === 0xe0);
    if (
      number &&
      type &&
      codec &&
      video &&
      ebmlUnsigned(bytes, number) > 0 &&
      ebmlUnsigned(bytes, type) === 1 &&
      ebmlText(bytes, codec).startsWith("V_")
    ) {
      parseEbmlElements(bytes, video.dataStart, video.end);
      sawVideoTrack = true;
    }
  }
  if (!sawVideoTrack) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM has no structurally valid video track",
    );
  }
}

function inspectWebmCluster(bytes: Uint8Array, cluster: EbmlElement): void {
  const fields = parseEbmlElements(bytes, cluster.dataStart, cluster.end);
  if (!fields.some((element) => element.id === 0xe7)) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM cluster has no timestamp",
    );
  }
  let sawBlock = false;
  for (const field of fields) {
    if (field.id === 0xa3) {
      validateWebmBlock(bytes, field);
      sawBlock = true;
    } else if (field.id === 0xa0) {
      const block = parseEbmlElements(bytes, field.dataStart, field.end)
        .find((element) => element.id === 0xa1);
      if (block) {
        validateWebmBlock(bytes, block);
        sawBlock = true;
      }
    }
  }
  if (!sawBlock) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM cluster has no media block",
    );
  }
}

function inspectWebm(bytes: Uint8Array): void {
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
  const headerFields = parseEbmlElements(bytes, headerStart, headerEnd);
  const documentTypes = headerFields.filter(
    (element) => element.id === 0x4282,
  );
  if (
    documentTypes.length !== 1 ||
    ebmlText(bytes, documentTypes[0]) !== "webm"
  ) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM document type is invalid",
    );
  }

  const segmentId = readEbmlId(bytes, headerEnd, bytes.length);
  if (segmentId.value !== 0x18538067) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM has no segment",
    );
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
    true,
  );
  const infoIndex = segmentFields.findIndex(
    (element) => element.id === 0x1549a966,
  );
  const tracksIndex = segmentFields.findIndex(
    (element) => element.id === 0x1654ae6b,
  );
  const clusterIndex = segmentFields.findIndex(
    (element) => element.id === 0x1f43b675,
  );
  if (
    infoIndex < 0 ||
    tracksIndex < 0 ||
    clusterIndex < 0 ||
    infoIndex > clusterIndex ||
    tracksIndex > clusterIndex
  ) {
    throw new InvalidGeneratedVideoError(
      "Generated WebM segment is missing required elements",
    );
  }
  parseEbmlElements(
    bytes,
    segmentFields[infoIndex].dataStart,
    segmentFields[infoIndex].end,
  );
  inspectWebmTracks(bytes, segmentFields[tracksIndex]);
  for (const cluster of segmentFields.filter(
    (element) => element.id === 0x1f43b675,
  )) {
    inspectWebmCluster(bytes, cluster);
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
  if (
    value.byteLength === 0 ||
    value.byteLength > MAX_AI_GENERATED_VIDEO_BYTES
  ) {
    throw new InvalidGeneratedVideoError(
      "Generated video size is invalid",
    );
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
