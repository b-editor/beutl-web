// The one byte range a content route serves, as media players ask for it to
// seek. Shared by every route that streams stored bytes.

/** Inclusive offsets of the bytes to send. */
export type ByteRange = { start: number; end: number };

/**
 * Reads a `Range: bytes=…` header for a resource of `size` bytes. Only a
 * single range is served; a header this does not understand, or one asking for
 * several ranges, gets the whole resource, as HTTP allows. A range that starts
 * past the end is "unsatisfiable" and answered with 416.
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/u.exec(header.trim()) : null;
  if (!match || (match[1] === "" && match[2] === "")) return null;
  const first = match[1] === "" ? undefined : Number(match[1]);
  const last = match[2] === "" ? undefined : Number(match[2]);
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return null;
  if (first === undefined) {
    // A suffix: the last `last` bytes.
    if (last === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - last!), end: size - 1 };
  }
  if (last !== undefined && last < first) return null;
  if (first >= size) return "unsatisfiable";
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

/** Headers for a 206 answer, or for a 416 when `range` is null. */
export function byteRangeHeaders(range: ByteRange | null, size: number): Record<string, string> {
  return range
    ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Content-Length": String(range.end - range.start + 1) }
    : { "Content-Range": `bytes */${size}` };
}
