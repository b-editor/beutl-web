export class GitDeltaError extends Error {}

function byte(data: Uint8Array, cursor: { position: number }): number {
  if (cursor.position >= data.length) throw new GitDeltaError("Truncated Git delta");
  return data[cursor.position++];
}

function unsigned(data: Uint8Array, cursor: { position: number }): number {
  let value: number, size = 0, scale = 1;
  do {
    value = byte(data, cursor); size += (value & 127) * scale; scale *= 128;
    if (!Number.isSafeInteger(size)) throw new GitDeltaError("Invalid Git delta size");
  } while (value & 128);
  return size;
}

export function readDeltaHeader(data: Uint8Array) {
  const cursor = { position: 0 };
  const source = unsigned(data, cursor), target = unsigned(data, cursor);
  return { source, target, position: cursor.position };
}

/** Validate delta instructions and optionally reconstruct an already bounded result. */
export function readDelta(data: Uint8Array, { source, target, position }: ReturnType<typeof readDeltaHeader>,
  base?: Uint8Array, consumeOperation?: () => void): Uint8Array<ArrayBuffer> | undefined {
  if (base && base.length !== source) throw new GitDeltaError("Git delta base size mismatch");
  const cursor = { position }, object = base ? new Uint8Array(target) : undefined;
  let written = 0;
  while (cursor.position < data.length) {
    consumeOperation?.();
    const command = byte(data, cursor);
    let length = 0, offset = 0;
    if (command & 128) {
      for (let i = 0; i < 4; i++) if (command & (1 << i)) offset += byte(data, cursor) * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (command & (16 << i)) length += byte(data, cursor) * 2 ** (8 * i);
      length ||= 0x10000;
      if (offset + length > source) throw new GitDeltaError("Git delta copy is out of bounds");
    } else {
      if (!command || cursor.position + command > data.length) throw new GitDeltaError("Invalid Git delta insert");
      offset = cursor.position; length = command; cursor.position += length;
    }
    if (written + length > target) throw new GitDeltaError("Git delta exceeds its declared output size");
    if (object) object.set((command & 128 ? base! : data).subarray(offset, offset + length), written);
    written += length;
  }
  if (written !== target) throw new GitDeltaError("Git delta output size mismatch");
  return object;
}
