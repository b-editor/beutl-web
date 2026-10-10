/** Blob.stream() may emit the entire blob in one chunk. Slice first to bound allocations on every runtime. */
export function blobStream(blob: Pick<Blob, "size" | "slice">): ReadableStream<Uint8Array<ArrayBuffer>> {
  let position = 0, cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      if (position === blob.size) { controller.close(); return; }
      const end = Math.min(position + 64 * 1024, blob.size);
      const bytes = await blob.slice(position, end).arrayBuffer();
      if (cancelled) return;
      position = end; controller.enqueue(new Uint8Array(bytes));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
}
