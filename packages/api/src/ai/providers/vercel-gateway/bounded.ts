import { boundedBody } from "@beutl/core";
import { AiProviderError, InvalidAiProviderOutputError } from "../errors";

/**
 * Read a Gateway response, refusing one that is too large *while* it arrives.
 *
 * Checking `content-length` first and then calling `text()` looks bounded and
 * is not: a chunked reply declares no length, so the whole body lands in the
 * isolate before the guard runs. Counting bytes through the stream means an
 * oversized reply is cancelled at the limit instead of after it.
 */
export async function readBoundedJson(
  response: Response,
  maximumBytes: number,
  what: string,
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new AiProviderError(`Vercel AI Gateway ${what} exceeds the size limit`);
  }
  if (!response.body) {
    throw new AiProviderError(`Vercel AI Gateway ${what} carried no body`);
  }

  let text: string;
  try {
    text = await new Response(boundedBody(response.body, maximumBytes)).text();
  } catch (cause) {
    throw new AiProviderError(
      `Vercel AI Gateway ${what} exceeds the size limit`,
      { cause },
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new InvalidAiProviderOutputError("Vercel AI Gateway returned invalid JSON", {
      cause,
    });
  }
}

/** The same bound, for a reply whose bytes are the payload. */
export async function readBoundedBytes(
  response: Response,
  maximumBytes: number,
  what: string,
): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new AiProviderError(`Vercel AI Gateway ${what} exceeds the size limit`);
  }
  if (!response.body) {
    throw new AiProviderError(`Vercel AI Gateway ${what} carried no body`);
  }
  try {
    return await new Response(
      boundedBody(response.body, maximumBytes),
    ).arrayBuffer();
  } catch (cause) {
    throw new AiProviderError(
      `Vercel AI Gateway ${what} exceeds the size limit`,
      { cause },
    );
  }
}
