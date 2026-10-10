const CHUNK_BYTES = 64 * 1024;

/** Workers derive response Content-Length from the stream rather than trusting its header. */
export function knownLengthStream(stream: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  const Fixed = (globalThis as unknown as {
    FixedLengthStream?: new (length: number) => ReadableWritablePair<Uint8Array, Uint8Array>;
  }).FixedLengthStream;
  if (Fixed) return stream.pipeThrough(new Fixed(length));
  return stream;
}

export function chunksStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return iteratorStream((async function* () {
    for (const chunk of chunks) for (let offset = 0; offset < chunk.byteLength; offset += CHUNK_BYTES)
      yield chunk.subarray(offset, offset + CHUNK_BYTES);
  })());
}

export function iteratorStream(iterator: AsyncGenerator<Uint8Array, void>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      } catch (error) { controller.error(error); await iterator.return(); }
    },
    async cancel() { await iterator.return(); },
  }, { highWaterMark: 0 });
}

/** Small compressed input chunks also bound the output of highly compressible objects. */
export function inflateStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let position = 0;
  return new ReadableStream<BufferSource>({
    pull(controller) {
      if (position === bytes.byteLength) { controller.close(); return; }
      const end = Math.min(position + 128, bytes.byteLength);
      controller.enqueue(Uint8Array.from(bytes.subarray(position, end)));
      position = end;
    },
  }, { highWaterMark: 0 }).pipeThrough(new DecompressionStream("deflate"));
}

export async function streamPrefix(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader(), bytes = new Uint8Array(limit);
  let length = 0;
  try {
    while (length < limit) {
      const next = await reader.read();
      if (next.done) break;
      const count = Math.min(next.value.byteLength, limit - length);
      bytes.set(next.value.subarray(0, count), length); length += count;
    }
    return bytes.subarray(0, length);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function streamBytes(stream: ReadableStream<Uint8Array>, size: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader(), bytes = new Uint8Array(size);
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (length + next.value.byteLength > size) throw new Error("Git stream exceeds its declared size");
      bytes.set(next.value, length); length += next.value.byteLength;
    }
    if (length !== size) throw new Error("Git stream is truncated");
    return bytes;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export function sliceStream(stream: ReadableStream<Uint8Array>, start: number, length: number, total: number): ReadableStream<Uint8Array> {
  return iteratorStream((async function* () {
    const reader = stream.getReader();
    let position = 0;
    const end = start + length;
    try {
      for (;;) {
        if (position >= end && end < total) break;
        const next = await reader.read();
        if (next.done) { if (position < end) throw new Error("Git stream is truncated"); break; }
        const nextPosition = position + next.value.byteLength;
        if (nextPosition > total) throw new Error("Git stream exceeds its declared size");
        const from = Math.max(start, position), to = Math.min(end, nextPosition);
        if (to > from) yield next.value.subarray(from - position, to - position);
        position = nextPosition;
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  })());
}

/** A cursor over a stream; skips and copy commands never allocate their full length. */
export class ByteReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunk: Uint8Array = new Uint8Array();
  private position = 0;
  constructor(stream: ReadableStream<Uint8Array>) { this.reader = stream.getReader(); }
  async take(maximum: number): Promise<Uint8Array | null> {
    while (this.position === this.chunk.byteLength) {
      const next = await this.reader.read();
      if (next.done) return null;
      this.chunk = next.value; this.position = 0;
    }
    const end = Math.min(this.chunk.byteLength, this.position + maximum, this.position + CHUNK_BYTES);
    const value = this.chunk.subarray(this.position, end); this.position = end;
    return value;
  }
  async byte(): Promise<number> {
    const value = await this.take(1);
    if (!value) throw new Error("Truncated Git delta");
    return value[0];
  }
  async unsigned(): Promise<number> {
    let value: number, size = 0, scale = 1;
    do {
      value = await this.byte(); size += (value & 127) * scale; scale *= 128;
      if (!Number.isSafeInteger(size)) throw new Error("Invalid Git delta size");
    } while (value & 128);
    return size;
  }
  async skip(count: number): Promise<void> {
    while (count > 0) {
      const value = await this.take(count);
      if (!value) throw new Error("Truncated Git delta base");
      count -= value.byteLength;
    }
  }
  async cancel(): Promise<void> { await this.reader.cancel().catch(() => undefined); this.reader.releaseLock(); }
}
