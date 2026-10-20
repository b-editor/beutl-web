export class ResponseBodyError extends Error {
  constructor(
    readonly reason: "size_limit" | "read" | "encoding",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ResponseBodyError";
  }
}

export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  description: string,
): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (
      Number.isSafeInteger(contentLength) &&
      contentLength >= 0 &&
      contentLength > maximumBytes
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseBodyError("size_limit", `${description} exceeds the size limit`);
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        const error = new ResponseBodyError(
          "size_limit", `${description} exceeds the size limit`,
        );
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof ResponseBodyError) throw cause;
    throw new ResponseBodyError("read", `${description} could not be read`, { cause });
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// Bound bytes while streaming, before buffering or decoding the full response.
export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  description: string,
): Promise<string> {
  const bytes = await readBoundedResponseBytes(
    response,
    maximumBytes,
    description,
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new ResponseBodyError("encoding", `${description} is not valid UTF-8`, { cause });
  }
}
